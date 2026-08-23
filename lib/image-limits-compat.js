/**
 * Compatibility for mixed DSH release-candidate profiles.
 *
 * rc.8's API proxy validates `attachments.imageLimits.maxImageDimension`,
 * while an rc.7 host attachment store has no such field.  The mismatch makes
 * otherwise valid `session.history` responses fail schema validation.  Keep
 * this adapter deliberately narrow: only supply the rc.8 default when the
 * field is absent, and leave complete (or explicitly invalid) configurations
 * untouched.
 */

export const LEGACY_MAX_IMAGE_DIMENSION = 2_000

/**
 * Add the missing rc.8 projection field to a legacy attachment service.
 *
 * @param {{ imageLimits?: Record<string, unknown> }} attachments
 * @param {{ info?: (message: string) => void, warn?: (message: string) => void }} [log]
 * @returns {(() => void) | undefined} a guarded restoration callback when patched
 */
export function patchLegacyImageLimits(attachments, log = console) {
  const original = attachments?.imageLimits
  if (original === null || typeof original !== 'object') return undefined
  if (original.maxImageDimension !== undefined) return undefined

  const patched = Object.freeze({
    ...original,
    maxImageDimension: LEGACY_MAX_IMAGE_DIMENSION,
  })

  try {
    if (!Reflect.set(attachments, 'imageLimits', patched)
      || attachments.imageLimits !== patched) {
      log.warn?.('dsh-supervisor: could not adapt legacy attachment image limits')
      return undefined
    }
  } catch (error) {
    log.warn?.(`dsh-supervisor: could not adapt legacy attachment image limits: ${error?.message ?? error}`)
    return undefined
  }

  log.info?.(`dsh-supervisor: supplied legacy attachment maxImageDimension=${LEGACY_MAX_IMAGE_DIMENSION}`)
  return () => {
    // Do not undo a newer owner that replaced the limits after this adapter.
    if (attachments.imageLimits === patched) Reflect.set(attachments, 'imageLimits', original)
  }
}
