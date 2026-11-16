// A page asking for the microphone or the camera – a voice note, a call. Until 0.8.0 every such
// request was refused without a word, and the page could only say that something had gone wrong.
// Now each account has an answer for each device, given once, kept in accounts.json and changed in
// the account's settings, the way its notifications are. Pure, so the rules can be examined without
// Electron; main asks the question and keeps the answer.
import { mediaChoice, MEDIA_DEVICES } from './accounts.js'

// Chromium names the devices a request is for; the settings name them as the operator knows them.
const DEVICE_OF = { audio: 'microphone', video: 'camera' }

// The devices a request is for, or null when it names none, or one with no setting behind it: a
// request like that cannot be answered from the settings, and nothing here guesses on its behalf.
export function requestedDevices(mediaTypes) {
  if (!Array.isArray(mediaTypes) || !mediaTypes.length) return null
  if (!mediaTypes.every((type) => Object.hasOwn(DEVICE_OF, type))) return null
  const asked = new Set(mediaTypes.map((type) => DEVICE_OF[type]))
  return MEDIA_DEVICES.filter((device) => asked.has(device))
}

// What a request gets:
//   { grant: true }    every device it asks for is allowed – in front or not, the answer was given
//   { grant: false }   with the reason, for the log:
//     'unknown'        it asks for nothing this application has a setting for
//     'foreign'        the page asking is not the service's own – a sign-in page, a window opened
//                      for somewhere else. The settings speak for the account, and the account is
//                      its service: about any other page they say nothing, and nor does a question
//     'blocked'        a device it asks for is blocked, and then the whole request is, since a page
//                      gets everything it asked for or nothing
//     'background'     a device is not decided yet and the account is not in front: a question
//                      naming an account the operator is not looking at would come out of nowhere,
//                      over whatever they are doing. Refused this once, the device stays undecided.
//   { ask: [...] }     the devices to ask the operator about, the account being in front
// fromService has to be said, and said as true: a caller that leaves it out gets a refusal.
export function mediaDecision({ devices, account, inFront, fromService }) {
  if (!devices?.length) return { grant: false, reason: 'unknown' }
  if (fromService !== true) return { grant: false, reason: 'foreign' }
  const choices = devices.map((device) => mediaChoice(account, device))
  if (choices.includes('block')) return { grant: false, reason: 'blocked' }
  const undecided = devices.filter((_device, index) => choices[index] === 'ask')
  if (!undecided.length) return { grant: true }
  return inFront ? { ask: undecided } : { grant: false, reason: 'background' }
}

// The answer each button of the question gives, in the order of the buttons. Not now answers
// nothing: the page is refused this once and the next request asks again.
export const MEDIA_ANSWERS = ['allow', 'block', null]
const NOT_NOW = MEDIA_ANSWERS.indexOf(null)

const QUESTIONS = { microphone: 'mediaQuestionMicrophone', camera: 'mediaQuestionCamera' }

// The question, as options for dialog.showMessageBox. Enter and Esc land on Not now: a question
// that appears while the operator is typing must not be answered yes by the next key.
export function mediaQuestion({ account, devices, tr }) {
  const key = devices.length > 1 ? 'mediaQuestionBoth' : QUESTIONS[devices[0]]
  return {
    type: 'question',
    title: 'M-HUB',
    message: tr(key, { account: account.name }),
    detail: tr('mediaQuestionDetail'),
    buttons: [tr('mediaAnswerAllow'), tr('mediaAnswerBlock'), tr('mediaAnswerNotNow')],
    defaultId: NOT_NOW,
    cancelId: NOT_NOW,
    noLink: true,
  }
}
