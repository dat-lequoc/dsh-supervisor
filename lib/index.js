/**
 * dsh-supervisor — setup plugin.
 *
 * The supervisor's core is an AGENT PRESET (agent-presets/main-agent in this
 * package), and presets live in the user preset root, not in the plugin tree.
 * This host plugin bridges the two at mount: it installs the bundled preset
 * into `${DSH_HOME:-~/.dsh}/.agent-presets/main-agent` so the package works
 * out of the box after `dsh plugin add`.
 *
 * Behavior is deliberately non-destructive: an existing preset directory is
 * NEVER overwritten unless config says `syncPreset: 'always'` — user edits to
 * the persona are user property. Runs in the Node realm (repository plugin),
 * so plain node:fs is the supported path.
 *
 * Config (all optional):
 *   syncPreset: 'if-absent' (default) | 'always' | 'never'
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-supervisor'
export const inject = []

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PRESET_ID = 'main-agent'

/**
 * Install the bundled preset into the user preset root (idempotent).
 * @param {import('@deepseek-ai/cordis').Context} _ctx - unused; installation
 *   is a filesystem fact, not a runtime registration, so there is nothing to
 *   dispose on unmount (an installed preset outliving the plugin is the point).
 * @param {{ syncPreset?: 'if-absent' | 'always' | 'never' }} [config]
 */
export function apply(ctx, config) {
  // Cordis contexts carry a logger; console remains the fallback for odd hosts.
  const log = ctx?.logger ?? console
  const mode = config?.syncPreset ?? 'if-absent'
  if (mode === 'never') return
  const source = join(PACKAGE_ROOT, 'agent-presets', PRESET_ID)
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const target = join(home, '.agent-presets', PRESET_ID)
  try {
    if (!existsSync(join(source, 'agent.cordis.yml'))) {
      log.warn(`dsh-supervisor: packaged preset missing at ${source} — broken install`)
      return
    }
    if (existsSync(target) && mode !== 'always') {
      log.info(`dsh-supervisor: preset "${PRESET_ID}" already present at ${target} — leaving it untouched (syncPreset: 'always' to overwrite)`)
      return
    }
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, { recursive: true })
    log.info(`dsh-supervisor: installed preset "${PRESET_ID}" -> ${target}`)
  } catch (error) {
    // Never fail the boot over preset sync; the manual path (README) remains.
    log.warn(`dsh-supervisor: preset install failed: ${error?.message ?? error}`)
  }
}
