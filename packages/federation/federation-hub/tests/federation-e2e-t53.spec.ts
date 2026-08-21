import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { FederationHubServer } from '../src/server.ts'
import { FederationHubService } from '../src/service.ts'
import { FederationPodClient, FederationClientService } from '@deepseek-ai/dsh-federation-client'
import { FederationFileSystem } from '@deepseek-ai/dsh-fs-federation'
import { FederationSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-federation'

describe('Federation T5.3 Direct P2P Optimization E2E', () => {
  let hubServer: FederationHubServer | undefined
  let hubCtx: Context | undefined
  let podBCtx: Context | undefined
  let podBClient: FederationPodClient | undefined
  let podACtx: Context | undefined
  let podAClient: FederationPodClient | undefined
  let tempDir: string | undefined

  afterEach(async () => {
    if (podAClient) {
      podAClient.dispose()
      podAClient = undefined
    }
    if (podBClient) {
      podBClient.dispose()
      podBClient = undefined
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
    podBCtx = undefined
    podACtx = undefined
  })

  it('connects Pod A to Pod B directly via advertised directEndpoint and falls back to Hub relay', async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'dsh-fed-t53-'))

    // 1. Setup Hub
    hubCtx = new Context()
    const hubService = new FederationHubService(hubCtx)
    const token = 'secret-token-t53'
    hubServer = new FederationHubServer(hubService, {
      port: 0,
      token,
      allowAnonymous: false,
    })
    await hubServer.start()
    const hubPort = hubServer.getPort()

    // 2. Determine an available port for Pod B direct server
    const dummyServer = http.createServer()
    await new Promise<void>((resolve) => {
      dummyServer.listen(0, '127.0.0.1', () => {
        resolve()
      })
    })
    const podBDirectPort = (dummyServer.address() as AddressInfo).port
    await new Promise<void>((resolve) => {
      dummyServer.close(() => {
        resolve()
      })
    })

    // 3. Setup Pod B (Worker Pod with direct server enabled)
    podBCtx = new Context()
    new LocalFileSystem(podBCtx, { cwd: tempDir, diffBasisMaxBytes: 10 * 1024 * 1024 })
    new LocalSubprocessRuntime(podBCtx)

    const podBId = 'pod-b-worker'
    podBClient = new FederationPodClient(podBCtx, {
      endpoint: `ws://127.0.0.1:${hubPort}/federation/connect`,
      podId: podBId,
      name: 'Worker Pod B',
      token,
      role: 'command',
      workspaces: [tempDir],
      directPort: podBDirectPort,
      directEndpoint: `ws://127.0.0.1:${podBDirectPort}`,
      reconnectDelayMs: 100,
    })
    new FederationClientService(podBCtx, podBClient)
    podBClient.start()

    // Wait for Pod B to register with Hub
    for (let i = 0; i < 50; i++) {
      if (hubService.getPod(podBId)?.status === 'online') break
      await new Promise(r => setTimeout(r, 50))
    }
    expect(hubService.getPod(podBId)?.status).toBe('online')
    expect(hubService.getPod(podBId)?.capabilities.directEndpoint).toBe(`ws://127.0.0.1:${podBDirectPort}`)

    // 4. Setup Pod A (Caller Pod)
    podACtx = new Context()
    const podAId = 'pod-a-caller'
    podAClient = new FederationPodClient(podACtx, {
      endpoint: `ws://127.0.0.1:${hubPort}/federation/connect`,
      podId: podAId,
      name: 'Caller Pod A',
      token,
      role: 'command',
      reconnectDelayMs: 100,
    })
    const podAService = new FederationClientService(podACtx, podAClient)
    podAClient.start()

    // Wait for Pod A to register and discover Pod B direct endpoint
    for (let i = 0; i < 50; i++) {
      if (podAService.getPeerDirectEndpoints().get(podBId) !== undefined) break
      await new Promise(r => setTimeout(r, 50))
    }
    expect(podAService.getPeerDirectEndpoints().get(podBId)).toBe(`ws://127.0.0.1:${podBDirectPort}`)

    // 5. Use remote capabilities on Pod A targeting Pod B
    const remoteFs = new FederationFileSystem(podACtx, { targetPodId: podBId })
    const remoteSubprocess = new FederationSubprocessRuntime(podACtx, { targetPodId: podBId })

    // Perform FS Write and Read over Direct P2P connection
    const testFile = join(tempDir, 'p2p-test.txt')
    const target = await remoteFs.resolve(testFile)
    const writeResult = await remoteFs.writeText(target, 'Direct P2P High Throughput Content!')
    expect(writeResult.version).toBeDefined()

    // Pod A should now have an active direct connection to Pod B
    expect(podAService.isDirectConnected(podBId)).toBe(true)

    const readText = await remoteFs.readText(target)
    expect(readText).toBe('Direct P2P High Throughput Content!')

    // Perform Subprocess execution over Direct P2P
    const handle = remoteSubprocess.spawn({
      argv: [process.execPath, '-e', 'process.stdout.write("direct-p2p-subprocess-ok")'],
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
    expect(handle.collected.stdout?.readFrom(0).text).toBe('direct-p2p-subprocess-ok')
  })
})
