/**
 * Write the generated GitHub Actions workflow into this repository.
 *
 * It lives here (instead of only being produced at build time) so that forking
 * the project is all a user has to do to get a working build worker: the
 * default branch of their fork already carries the workflow.
 *
 *   pnpm -F @rsdk-webui/shared emit:workflow
 */
import fs from 'node:fs'
import path from 'node:path'
import { renderGhWorkflow } from './render.ts'

const target = path.resolve(import.meta.dirname, '../../.github/workflows/build.yml')
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.writeFileSync(target, renderGhWorkflow())
console.log(`wrote ${path.relative(process.cwd(), target)}`)
