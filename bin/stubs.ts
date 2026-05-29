import { execa } from 'execa'
import { copyFile, readdir } from 'node:fs/promises'
import { resolve, dirname, join, relative } from 'node:path'

const color = require('cli-color')

const BASE_DIR = resolve(__dirname, '..')
const SRC_DIR = resolve(BASE_DIR, 'src')

console.log(color.blue('Searching for .stub files...'))
readdir(SRC_DIR, {
  withFileTypes: true,
  recursive: true,
}).then(async (files) => {
  const stubs: Set<string> = new Set()
  const dirs: Set<string> = new Set()
  files.forEach((file) => {
    if (file.isFile() && file.name.endsWith('.stub')) {
      stubs.add(join(file.parentPath, file.name))
      dirs.add(dirname(join(file.parentPath, file.name)))
    }
  })
  console.log(
    color.blue(
      `Found ${color.yellow(stubs.size)} .stub files in ${color.yellow(dirs.size)} directories.`
    )
  )
  const destinationDirs = Array.from(dirs).map((dir) => {
    const relPath = relative(SRC_DIR, dir)
    return join(BASE_DIR, 'dist', relPath)
  })
  console.log(color.blue('Creating destination directories...'))
  await Promise.all(
    destinationDirs.map(async (dir) => {
      await execa('mkdir', ['-p', dir], {
        cwd: BASE_DIR,
        stdio: 'inherit',
      })
    })
  )
  console.log(color.blue('Copying .stub files...'))
  await Promise.all(
    Array.from(stubs).map(async (stub) => {
      const relPath = relative(SRC_DIR, stub)
      const dstPath = join(BASE_DIR, 'dist', relPath)
      await copyFile(stub, dstPath)
    })
  )
  console.log(color.green('All .stub files copied successfully.'))
})
