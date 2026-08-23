import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LEGACY_MAX_IMAGE_DIMENSION,
  patchLegacyImageLimits,
} from '../lib/image-limits-compat.js'

function legacyLimits() {
  return Object.freeze({
    maxImageBytes: 5 * 1024 * 1024,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 100 * 1024 * 1024,
    maxImagePixels: 40_000_000,
    mediaTypes: Object.freeze(['image/png', 'image/jpeg']),
  })
}

test('adapts an rc.7 attachment store for the rc.8 history projection', () => {
  const original = legacyLimits()
  const attachments = { imageLimits: original }
  const messages = []

  const restore = patchLegacyImageLimits(attachments, {
    info: message => messages.push(message),
  })

  assert.equal(attachments.imageLimits.maxImageDimension, LEGACY_MAX_IMAGE_DIMENSION)
  assert.equal(attachments.imageLimits.maxImageBytes, original.maxImageBytes)
  assert.equal(attachments.imageLimits.mediaTypes, original.mediaTypes)
  assert.equal(Object.isFrozen(attachments.imageLimits), true)
  assert.deepEqual(messages, [
    `dsh-supervisor: supplied legacy attachment maxImageDimension=${LEGACY_MAX_IMAGE_DIMENSION}`,
  ])

  restore()
  assert.equal(attachments.imageLimits, original)
})

test('does not override a native maxImageDimension', () => {
  const limits = Object.freeze({ ...legacyLimits(), maxImageDimension: 4_096 })
  const attachments = { imageLimits: limits }

  assert.equal(patchLegacyImageLimits(attachments), undefined)
  assert.equal(attachments.imageLimits, limits)
})

test('restoration does not clobber a later attachment-service update', () => {
  const attachments = { imageLimits: legacyLimits() }
  const restore = patchLegacyImageLimits(attachments, { info() {} })
  const replacement = Object.freeze({ ...attachments.imageLimits, maxImageDimension: 8_192 })

  attachments.imageLimits = replacement
  restore()

  assert.equal(attachments.imageLimits, replacement)
})
