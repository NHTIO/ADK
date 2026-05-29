// import { execa } from 'execa'
// import { resolve, join, relative, dirname } from 'node:path'
// import { readFile, readdir, writeFile } from 'node:fs/promises'
// const color = require('cli-color')
// const cwd = resolve(__dirname, '..')
// const cliProgress = require('cli-progress')

// execa('mkdir', ['-p', 'types-temp'], { cwd, stdio: 'inherit' }).then(async () => {
//   const typesDir = join(cwd, 'types-temp')
//   const distDir = join(cwd, 'dist')
//   try {
//     console.log(color.blue('Generating Typescript Type Definition files...'))
//     await execa('npx', ['tsc', '--project', 'tsconfig.build.json'], {
//       cwd,
//       stdio: 'inherit',
//     })
//     console.log(color.blue('Copying Typescript Type Definition files...'))
//     const filesInSrc = await readdir(typesDir, {
//       withFileTypes: true,
//       recursive: true,
//     })
//     const pb = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic)
//     pb.start(filesInSrc.length, 0)
//     const messages: string[] = []
//     await Promise.all(
//       filesInSrc.map(async (file) => {
//         pb.increment()
//         if (!file.isFile()) {
//           return
//         }
//         const absPath = join(file.parentPath, file.name)
//         const relPath = relative(typesDir, absPath)
//         const dstPath = join(distDir, relPath)
//         const dstDir = dirname(dstPath)
//         const src = await readFile(absPath, 'utf-8')
//         await execa('mkdir', ['-p', dstDir], {
//           cwd,
//           stdio: 'inherit',
//         })
//         await writeFile(dstPath, src, 'utf-8')
//       })
//     )
//     pb.stop()
//     messages.forEach((msg) => console.log(msg))
//     console.log(color.green('Typescript Type Definition files copied successfully.'))
//   } catch (error) {
//     const e: Error = error as Error
//     console.error(color.red(e.stack || e.message || e))
//   }
//   console.log(color.blue('Cleaning up temporary files...'))
//   await execa('rm', ['-rf', 'types-temp'], { cwd, stdio: 'inherit' })
// })
