import { execa } from 'execa'
import { resolve } from 'node:path'

import type { Subprocess } from 'execa'

const cwd = resolve(__dirname, '..')
const nodemon = require('nodemon')
const color = require('cli-color')

const nodemonConfig = {
  watch: ['src/**/*', 'package.json', 'vite.config.mts'],
  ext: 'ts,json,env,scss,vue,md,yml,stub',
  ignore: ['node_modules'],
  exec: 'npx jiti bin/noop.ts',
  delay: '2500',
}

let subprocess: Subprocess | undefined
let abortController: AbortController | undefined

const cleanup = async () => {
  if (subprocess) {
    await subprocess.kill()
  }
  if (abortController) {
    abortController.abort()
  }
}

process
  .on('unhandledRejection', (reason, p) => {
    console.error(reason, 'Unhandled Rejection at Promise', p)
  })
  .on('uncaughtException', (err) => {
    console.error(err.stack)
    cleanup().finally(() => process.exit(1))
  })
  .on('SIGINT', () => {
    cleanup().finally(() => process.exit(255))
  })
  .on('SIGTERM', () => {
    cleanup().finally(() => process.exit(255))
  })

const doStart = async () => {
  // npx rimraf dist && vite build && npx jiti bin/package.ts
  if (subprocess) {
    await subprocess.kill()
  }
  if (abortController) {
    if (abortController.signal.aborted) {
      return
    }
    abortController.abort()
  }
  abortController = new AbortController()
  if (!abortController.signal.aborted) {
    await execa('npm', ['run', 'generate'], {
      cwd,
      cancelSignal: abortController.signal,
      stdio: 'inherit',
      reject: false,
    })
  }
}

nodemon(nodemonConfig)
let timeout: NodeJS.Timeout | undefined
nodemon
  .on('start', function () {
    console.log(color.green('Dev Process has started'))
    doStart()
  })
  .on('quit', function () {
    console.log(color.red('Dev Process has quit'))
    process.exit()
  })
  .on('restart', function (files: string[]) {
    console.log('App restarted due to: ', files)
    clearTimeout(timeout)
    timeout = setTimeout(() => doStart(), 1000)
  })
