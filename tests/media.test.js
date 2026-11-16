import { describe, test, expect } from 'vitest'
import { requestedDevices, mediaDecision, mediaQuestion, MEDIA_ANSWERS } from '../src/main/media.js'
import { t } from '../src/shared/i18n.js'

const account = { id: 'acc-wa-work', name: 'WhatsApp work', platform: 'whatsapp' }

describe('which devices a request is for', () => {
  test('audio is the microphone and video the camera', () => {
    expect(requestedDevices(['audio'])).toEqual(['microphone'])
    expect(requestedDevices(['video'])).toEqual(['camera'])
    expect(requestedDevices(['video', 'audio'])).toEqual(['microphone', 'camera'])
  })

  // Chromium names the devices. A request naming none, or one with no setting behind it, cannot be
  // answered from the account's settings, and nothing here guesses on its behalf.
  test('a request naming no device, or one with no setting, is for nothing that can be allowed', () => {
    expect(requestedDevices([])).toBeNull()
    expect(requestedDevices(undefined)).toBeNull()
    expect(requestedDevices(['audio', 'screen'])).toBeNull()
  })
})

describe('what a request for the microphone or the camera gets', () => {
  const service = { fromService: true }

  test('a device allowed is granted without a question', () => {
    const allowed = { ...account, microphone: 'allow' }
    expect(mediaDecision({ devices: ['microphone'], account: allowed, inFront: true, ...service })).toEqual({ grant: true })
  })

  // The answer was given already; where the account stands now does not change it.
  test('a device allowed is granted in the background too', () => {
    const allowed = { ...account, microphone: 'allow', camera: 'allow' }
    expect(mediaDecision({ devices: ['microphone', 'camera'], account: allowed, inFront: false, ...service })).toEqual({
      grant: true,
    })
  })

  test('a blocked device refuses the whole request, even beside an allowed one', () => {
    const mixed = { ...account, microphone: 'allow', camera: 'block' }
    expect(mediaDecision({ devices: ['microphone', 'camera'], account: mixed, inFront: true, ...service })).toEqual({
      grant: false,
      reason: 'blocked',
    })
  })

  test('a device not decided yet is asked about while the account is in front', () => {
    const half = { ...account, microphone: 'allow' }
    expect(mediaDecision({ devices: ['microphone', 'camera'], account: half, inFront: true, ...service })).toEqual({
      ask: ['camera'],
    })
    expect(mediaDecision({ devices: ['microphone'], account, inFront: true, ...service })).toEqual({ ask: ['microphone'] })
  })

  // A question naming an account the operator is not looking at would arrive out of nowhere, over
  // whatever they are doing. Refused this once, the device stays undecided for the next time.
  test('in the background nothing is asked: refused this once, and still undecided', () => {
    expect(mediaDecision({ devices: ['microphone'], account, inFront: false, ...service })).toEqual({
      grant: false,
      reason: 'background',
    })
  })

  test('a request for nothing known is refused', () => {
    const allowed = { ...account, microphone: 'allow', camera: 'allow' }
    expect(mediaDecision({ devices: null, account: allowed, inFront: true, ...service })).toEqual({
      grant: false,
      reason: 'unknown',
    })
  })

  // The settings speak for the account, and the account is its service. A sign-in page, or a window
  // opened for somewhere else, shares the account's session without being the account: an allow
  // given to WhatsApp is not one given to them, and a question would name the wrong party.
  test('a page that is not the service gets nothing, however the account is set', () => {
    const allowed = { ...account, microphone: 'allow', camera: 'allow' }
    expect(mediaDecision({ devices: ['microphone'], account: allowed, inFront: true, fromService: false })).toEqual({
      grant: false,
      reason: 'foreign',
    })
    expect(mediaDecision({ devices: ['camera'], account, inFront: true, fromService: false })).toEqual({
      grant: false,
      reason: 'foreign',
    })
  })

  // Left out is refused, not granted: a caller that forgets to ask where the request came from must
  // not hand out the device on the strength of the account's settings alone.
  test('a request nobody said came from the service is refused', () => {
    const allowed = { ...account, microphone: 'allow' }
    expect(mediaDecision({ devices: ['microphone'], account: allowed, inFront: true })).toEqual({
      grant: false,
      reason: 'foreign',
    })
    expect(mediaDecision({ devices: ['microphone'], account: allowed, inFront: true, fromService: 'yes' })).toEqual({
      grant: false,
      reason: 'foreign',
    })
  })
})

describe('the question', () => {
  const pl = (key, params) => t('pl', key, params)
  const en = (key, params) => t('en', key, params)

  test('names the account and the device, in the interface language', () => {
    expect(mediaQuestion({ account, devices: ['microphone'], tr: pl }).message).toBe('Konto WhatsApp work chce użyć mikrofonu.')
    expect(mediaQuestion({ account, devices: ['camera'], tr: pl }).message).toBe('Konto WhatsApp work chce użyć kamery.')
    expect(mediaQuestion({ account, devices: ['microphone', 'camera'], tr: pl }).message).toBe(
      'Konto WhatsApp work chce użyć mikrofonu i kamery.',
    )
    expect(mediaQuestion({ account, devices: ['microphone'], tr: en }).message).toBe('WhatsApp work wants to use the microphone.')
  })

  // Enter and Esc land on Not now: a question that pops up while the operator is typing must not be
  // answered yes by the next key.
  test('offers allow, block and not now, and the keys land on not now', () => {
    const question = mediaQuestion({ account, devices: ['microphone'], tr: pl })
    expect(question.buttons).toEqual(['Zezwól', 'Blokuj', 'Nie teraz'])
    expect(MEDIA_ANSWERS).toEqual(['allow', 'block', null])
    expect(question.defaultId).toBe(2)
    expect(question.cancelId).toBe(2)
    expect(question.noLink).toBe(true)
  })

  test('says the answer is kept, and where to change it', () => {
    expect(mediaQuestion({ account, devices: ['camera'], tr: pl }).detail).toBe(
      'Odpowiedź zostanie zapamiętana dla tego konta – zmienisz ją w jego ustawieniach.',
    )
  })
})
