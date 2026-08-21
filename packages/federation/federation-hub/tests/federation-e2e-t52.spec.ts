import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { FederationHubServer } from '../src/server.ts'
import { FederationHubService } from '../src/service.ts'
import { FederationPodClient } from '@deepseek-ai/dsh-federation-client'
import { FederationFileSystem } from '@deepseek-ai/dsh-fs-federation'
import { FederationSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-federation'

describe('Federation T5.2 Capability E2E', () => {
  let hubServer: FederationHubServer | undefined
  let hubCtx: Context | undefined
  let podCtx: Context | undefined
  let podClient: FederationPodClient | undefined
  let callerCtx: Context | undefined
  let tempDir: string | undefined

  afterEach(async () => {
    if (podClient) {
      podClient.dispose()
      podClient = undefined
    }
    if (hubServer) {
      await hubServer.stop()
      hubServer = undefined
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      tempDir = undefined
    }
    hubCtx = undefined
    podCtx = undefined
    callerCtx = undefined
  })

  it('executes remote fs and subprocess operations on edge pod via federation hub', async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'dsh-fed-t52-'))

    // 1. Setup Hub
    hubCtx = new Context()
    const hubService = new FederationHubService(hubCtx)
    const token = 'secret-token-t52'
    hubServer = new FederationHubServer(hubService, {
      port: 0,
      token,
      allowAnonymous: false,
    })
    await hubServer.start()
    const hubPort = hubServer.getPort()

    // 2. Setup Pod with local fs and subprocess
    podCtx = new Context()
    new LocalFileSystem(podCtx, { cwd: tempDir, diffBasisMaxBytes: 10 * 1024 * 1024 })
    new LocalSubprocessRuntime(podCtx)

    const podId = 'pod-agent-worker'
    podClient = new FederationPodClient(podCtx, {
      endpoint: `ws://127.0.0.1:${hubPort}/federation/connect`,
      podId,
      name: 'Agent Worker Pod',
      token,
      role: 'command',
      workspaces: [tempDir],
      reconnectDelayMs: 100,
    })
    podClient.start()

    // Wait for pod to connect to hub
    for (let i = 0; i < 50; i++) {
      if (hubService.getPod(podId)?.status === 'online') break
      await new Promise(r => setTimeout(r, 50))
    }
    expect(hubService.getPod(podId)?.status).toBe('online')

    // 3. Setup Caller (Hub in Cloud Mode)
    callerCtx = new Context()
    callerCtx.federationHub = hubService
    const remoteFs = new FederationFileSystem(callerCtx, { targetPodId: podId })
    const remoteSubprocess = new FederationSubprocessRuntime(callerCtx, { targetPodId: podId })

    // --- Test Filesystem Operations ---
    const filePath = join(tempDir, 'greeting.txt')
    const target = await remoteFs.resolve(filePath)
    expect(target.displayPath).toBe(filePath)

    // Write file
    const writeRes = await remoteFs.writeText(target, 'Hello from Federation Hub!\nSecond Line.\n')
    expect(writeRes.version).toBeDefined()

    // Stat file
    const stat = await remoteFs.stat(target)
    expect(stat).toBeDefined()
    expect(stat?.type).toBe('file')
    expect(stat?.size).toBeGreaterThan(0)

    // Read text file
    const content = await remoteFs.readText(target)
    expect(content).toBe('Hello from Federation Hub!\nSecond Line.\n')

    // Stream text file
    const streamChunks: string[] = []
    for await (const chunk of await remoteFs.streamText(target)) {
      streamChunks.push(chunk)
    }
    expect(streamChunks.join('')).toBe('Hello from Federation Hub!\nSecond Line.\n')

    // Edit text file
    const editRes = await remoteFs.editText(target, {
      oldString: 'Hello from Federation Hub!',
      newString: 'Hello from Remote Pod!',
      replaceAll: false,
    })
    expect(editRes.version).toBeDefined()

    const updatedContent = await remoteFs.readText(target)
    expect(updatedContent).toContain('Hello from Remote Pod!')

    // Read bytes
    const bytes = await remoteFs.readBytes(target, undefined, 1024)
    expect(Buffer.from(bytes).toString('utf-8')).toContain('Hello from Remote Pod!')

    // List dir
    const dirTarget = await remoteFs.resolve(tempDir)
    const dirEntries = await remoteFs.listDir(dirTarget)
    expect(dirEntries.length).toBe(1)
    expect(dirEntries[0]!.name).toBe('greeting.txt')

    // --- Test Subprocess Operations ---
    const nodePath = await remoteSubprocess.resolveExecutable('node')
    expect(nodePath).toBeDefined()

    // Execute script and collect stdout
    const testScript = 'console.log("Subprocess remote output: " + (2 + 3))'
    const handle = remoteSubprocess.spawn({
      argv: [nodePath, '-e', testScript],
      cwd: tempDir,
      graceMs: 2000,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 1024 },
        stderr: { maxBytes: 1024 },
      },
    })

    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)
    const stdout = handle.collected.stdout?.readFrom(0)
    expect(stdout?.text).toContain('Subprocess remote output: 5')

    // --- Negative Security Test: Assert DEEPSEEK_API_KEY is not leaked into child env ---
    process.env.DEEPSEEK_API_KEY = 'super-secret-model-key'
    const envCheckHandle = remoteSubprocess.spawn({
      argv: [nodePath, '-e', 'console.log("KEY_CHECK=" + (process.env.DEEPSEEK_API_KEY || "NOT_PRESENT"))'],
      cwd: tempDir,
      graceMs: 2000,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 1024 },
        stderr: { maxBytes: 1024 },
      },
    })
    delete process.env.DEEPSEEK_API_KEY

    const envOutcome = await envCheckHandle.done
    expect(envOutcome.exitCode).toBe(0)
    const envStdout = envCheckHandle.collected.stdout?.readFrom(0)
    expect(envStdout?.text).toContain('KEY_CHECK=NOT_PRESENT')
    expect(envStdout?.text).not.toContain('super-secret-model-key')

    // --- Test Disconnect / Offline behavior ---
    podClient.dispose()
    podClient = undefined
    await new Promise(r => setTimeout(r, 100))

    await expect(remoteFs.readText(target)).rejects.toThrow()
  })
})
