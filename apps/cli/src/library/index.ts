/**
 * `@schwabyio/gta`: a project's collections and request sets, run from code
 * on the engine `gta` runs them on.
 *
 *     import { openProject } from '@schwabyio/gta'
 *
 *     const project = await openProject('api-tests', { environment: 'staging' })
 *     const login = await project.use('login', { username: 'alice', password: 'secret' })
 *     const checkout = await project.run('checkout', { vars: login.values })
 *     if (!checkout.passed) console.error(checkout.failures)
 *
 * Every export says its type outright, so the published `.d.ts` is made from
 * this file alone (build.mjs).
 */
import { openProject as open } from './project.js'
import type { OpenProjectFunction } from './types.js'

export const openProject: OpenProjectFunction = open

export type * from './types.js'
