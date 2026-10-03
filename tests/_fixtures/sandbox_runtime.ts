import { spawnSync } from 'node:child_process'

/**
 * Whether real-SRT tests can execute on this host.
 *
 * @remarks
 * SRT needs `rg` everywhere and, on Linux, `bwrap` and `socat`. An outer bwrap namespace can
 * succeed while SRT's apply-seccomp helper is refused a nested user namespace. The gate therefore
 * executes a real SRT smoke command in a separate process, keeping the process-global manager out
 * of the test process. `TEST_SANDBOX_LIVE_FORCE=1` deliberately bypasses the gate.
 */
export const canUnshareUserNamespace = (): boolean => {
  if (process.platform !== 'linux') return true // darwin uses Seatbelt, not bwrap
  try {
    const { status } = spawnSync(
      'bwrap',
      [
        '--unshare-user',
        '--unshare-all',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--ro-bind',
        '/',
        '/',
        '/bin/true',
      ],
      { stdio: 'ignore', timeout: 10_000 }
    )
    return status === 0
  } catch {
    return false
  }
}

const onPath = (command: string): boolean => {
  try {
    return (
      spawnSync(command, ['--version'], { stdio: 'ignore', timeout: 10_000 }).error === undefined
    )
  } catch {
    return false
  }
}

const missingDependencies = (): string[] => {
  const required = ['rg', ...(process.platform === 'linux' ? ['bwrap', 'socat'] : [])]
  return required.filter((command) => !onPath(command))
}

// Plain JavaScript evaluated by Node: no TS loader or test-runner state enters the probe.
const smokeScript = `
  const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
  const { spawn } = await import('node:child_process');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'srt-smoke-'));
  try {
    await SandboxManager.initialize({
      filesystem: {
        denyRead: [], allowRead: [root], allowWrite: [root], denyWrite: [],
        allowGitConfig: false,
      },
      network: {
        allowedDomains: [], deniedDomains: [], strictAllowlist: true,
        allowLocalBinding: false, allowUnixSockets: [], allowMachLookup: [],
      },
      git: { safeDirectories: [root] },
    });
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      'printf hello', '/bin/sh', undefined, undefined, root
    );
    const result = await new Promise((resolve, reject) => {
      const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
        cwd: root, env: wrapped.env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { process.stderr.write(data); });
      child.on('error', reject);
      child.on('close', (exitCode) => resolve({ exitCode, stdout }));
    });
    console.log(JSON.stringify(result));
    if (result.exitCode !== 0 || result.stdout !== 'hello') {
      console.error('SRT smoke execution failed: ' + JSON.stringify(result));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    try { await SandboxManager.reset(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
`

const probeRuntime = (): { available: boolean; reason: string } => {
  const missing = missingDependencies()
  if (missing.length > 0)
    return { available: false, reason: `missing dependencies: ${missing.join(', ')}` }
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', smokeScript], {
    encoding: 'utf8',
    timeout: 20_000,
  })
  try {
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1) ?? '') as {
      exitCode: number | null
      stdout: string
    }
    if (child.status === 0 && result.exitCode === 0 && result.stdout === 'hello')
      return { available: true, reason: 'real SRT smoke execution is available' }
  } catch {
    // A crashed or timed-out child may not have emitted its result.
  }
  return {
    available: false,
    reason:
      child.stderr.trim().split('\n')[0] ||
      child.error?.message ||
      `SRT smoke probe exited with status ${child.status}`,
  }
}

const forced = process.env.TEST_SANDBOX_LIVE_FORCE === '1'
const runtime = forced
  ? { available: true, reason: 'forced by TEST_SANDBOX_LIVE_FORCE=1' }
  : probeRuntime()
export const sandboxRuntimeGate = runtime.available
export const sandboxRuntimeGateReason = runtime.reason
