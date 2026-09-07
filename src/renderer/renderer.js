import { toHtml } from './preview.js'
import { t, availableLanguages, validLanguage, DEFAULT_LANGUAGE } from '../shared/i18n.js'
import { parseTags, formatTags } from '../shared/tags.js'
import { findVariables } from '../shared/variables.js'
import { PLATFORM_DEFAULT_NOTIFICATIONS } from '../shared/platform-defaults.js'
import { formatBytes } from '../shared/bytes.js'

// Interface language. The value arrives from the main process at startup, so until the
// answer comes back we hold the default – otherwise the first frame would show bare keys.
let language = DEFAULT_LANGUAGE
const tr = (key, params) => t(language, key, params)

// Static text carries data-i18n keys in the HTML and is swapped in place. That way
// changing the language needs no window reload – and a reload would tear down the
// native account views along with their sign-ins.
function translateDocument() {
  document.documentElement.lang = language
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = tr(element.dataset.i18n)
  }
  for (const element of document.querySelectorAll('[data-i18n-title]')) {
    element.title = tr(element.dataset.i18nTitle)
  }
  for (const element of document.querySelectorAll('[data-i18n-placeholder]')) {
    element.placeholder = tr(element.dataset.i18nPlaceholder)
  }
  for (const element of document.querySelectorAll('[data-i18n-aria]')) {
    element.setAttribute('aria-label', tr(element.dataset.i18nAria))
  }
}

const rail = document.getElementById('rail')
const channels = document.getElementById('channels')
const languageSelect = document.getElementById('language-select')
const accountDialog = document.getElementById('account-dialog')
const accountErrors = document.getElementById('account-errors')
const macrosDialog = document.getElementById('macros-dialog')
const macroSearch = document.getElementById('macro-search')
const macroList = document.getElementById('macro-list')

let activeAccountId = null
let railAccounts = []
let unreadByAccount = {}

function unreadLabel(count) {
  return count ? tr('unreadNew', { n: count }) : tr('noNew')
}

// The active account's colour outlines the whole working area – it is the only saturated
// element in the window and the only constant answer to "who am I right now".
function paintChannel(account) {
  document.documentElement.style.setProperty('--channel', account?.color ?? '#2f7d5b')

  for (const [chip, name] of [
    [document.getElementById('status-chip'), document.getElementById('status-name')],
    [document.getElementById('target-chip'), document.getElementById('target-name')],
  ]) {
    chip.style.setProperty('--tint', account?.color ?? 'transparent')
    name.textContent = account?.name ?? tr('noAccounts')
  }

  const total = Object.values(unreadByAccount).reduce((sum, n) => sum + n, 0)
  document.getElementById('status-unread').textContent = total
    ? tr('unreadTotal', { n: total })
    : tr('allRead')
}

async function switchTo(accountId) {
  activeAccountId = accountId
  await window.mHub.switchAccount(accountId)
  for (const channel of channels.children) {
    channel.setAttribute('aria-selected', String(channel.dataset.accountId === accountId))
  }
  paintChannel(railAccounts.find((a) => a.id === accountId))
}

function refreshUnread() {
  for (const channel of channels.children) {
    const count = unreadByAccount[channel.dataset.accountId] ?? 0
    const meta = channel.querySelector('.channel-meta')
    meta.textContent = unreadLabel(count)
    meta.classList.toggle('unread', count > 0)
    // Collapsed, there is no name, so the channel colour alone has to carry unread.
    channel.classList.toggle('has-unread', count > 0)
  }
  paintChannel(railAccounts.find((a) => a.id === activeAccountId))
}

// The rail collapses to bare channel colours and expands on hover – until it is pinned,
// which holds it open. The main process owns the state, because it also computes the
// geometry of the views; the renderer only reports hover and paints the answer.
let railPinned = false

function applyRailState({ pinned, expanded }) {
  railPinned = Boolean(pinned)
  document.documentElement.style.setProperty('--rail', expanded ? '162px' : '48px')
  rail.classList.toggle('expanded', Boolean(expanded))
  rail.classList.toggle('pinned', railPinned)
  const button = document.getElementById('pin-rail')
  button.title = tr(railPinned ? 'unpinRail' : 'pinRail')
  button.setAttribute('aria-pressed', String(railPinned))
}

rail.addEventListener('mouseenter', () => window.mHub.hoverRail(true))

// A mouseleave does not always mean the pointer left. Chromium fires one when the window
// stops being the foreground window, carrying the position the pointer had all along –
// measured 2026-08-25 at clientX 24 inside a rail box of 0..162, with the cursor never
// moved. Whether that is worth acting on is the main process's call, because only it knows
// whether the window is still focused; the renderer's job is to report WHERE the pointer
// was when the event arrived, which is the one thing the event actually knows.
rail.addEventListener('mouseleave', (event) => {
  const box = rail.getBoundingClientRect()
  const pointerStillInside =
    event.clientX >= box.left &&
    event.clientX < box.right &&
    event.clientY >= box.top &&
    event.clientY < box.bottom
  window.mHub.hoverRail(false, pointerStillInside)
})

document.getElementById('pin-rail').addEventListener('click', () => {
  window.mHub.pinRail(!railPinned)
})

window.mHub.onRailChange(applyRailState)

// Ctrl+1..9 arrives from the main process as a POSITION, because that is all a digit means.
// Which account sits at that position is the rail's business, and past the end of a short
// rail the answer is simply nobody.
window.mHub.onSelectAccount((index) => {
  const account = railAccounts[index]
  if (account) switchTo(account.id)
})

// A view took the system's focus on its own – a clicked notification, most likely. The rail
// has to follow it rather than the other way round.
window.mHub.onSelectAccountId((accountId) => {
  if (railAccounts.some((a) => a.id === accountId)) switchTo(accountId)
})

// The main process holds back a leave that arrived while the window was in the background,
// and asks again once the window is back. :hover is Chromium's own answer to "is the
// pointer over this element", which is exactly the question, and the only one worth
// trusting after a spell in which our mouse events were not being delivered.
window.mHub.onRailRecheck(() => window.mHub.hoverRail(rail.matches(':hover'), false))

async function refreshRail() {
  railAccounts = await window.mHub.listAccounts()

  // The rail rebuilds itself after every rename and reorder. Without remembering the
  // account, the operator would land back on the first channel every single time.
  const selected = railAccounts.some((a) => a.id === activeAccountId)
    ? activeAccountId
    : railAccounts[0]?.id ?? null

  channels.replaceChildren()
  for (const account of railAccounts) {
    const channel = document.createElement('button')
    channel.className = 'channel'
    channel.dataset.accountId = account.id
    channel.style.setProperty('--tint', account.color)
    channel.setAttribute('aria-selected', String(account.id === selected))
    channel.title = `${account.name} (${account.platform})`

    const chip = document.createElement('i')
    chip.className = 'chip'

    const name = document.createElement('span')
    name.className = 'channel-name'
    name.textContent = account.name

    // The second line answers the only question that changes minute to minute: does this
    // channel need me. The platform is already in the name and in the settings.
    const meta = document.createElement('span')
    meta.className = 'channel-meta'
    meta.textContent = unreadLabel(unreadByAccount[account.id] ?? 0)
    meta.classList.toggle('unread', (unreadByAccount[account.id] ?? 0) > 0)

    channel.append(chip, name, meta)
    channel.addEventListener('click', () => switchTo(account.id))
    channels.append(channel)
  }

  if (selected) await switchTo(selected)
  else paintChannel(null)
}

let editedAccountId = null

async function openAccountForm(account = null) {
  editedAccountId = account?.id ?? null
  accountErrors.textContent = ''

  const form = accountDialog.querySelector('form')
  form.reset()
  document.getElementById('account-dialog-title').textContent = tr(account ? 'editAccount' : 'addAccount')

  // The platform determines the address and the session partition – swapping it would be
  // a different account, not a correction of this one, so the field is locked when editing.
  const platform = form.querySelector('select[name="platform"]')
  platform.disabled = Boolean(account)

  const notifications = form.querySelector('input[name="notifications"]')

  if (account) {
    form.querySelector('input[name="name"]').value = account.name
    platform.value = account.platform
    form.querySelector('input[name="color"]').value = account.color
    notifications.checked = account.notifications ?? PLATFORM_DEFAULT_NOTIFICATIONS[account.platform] ?? false
  } else {
    // Two accounts in one colour cancel out the identity signal – suggest a free one.
    form.querySelector('input[name="color"]').value = await window.mHub.unusedColor()
    notifications.checked = PLATFORM_DEFAULT_NOTIFICATIONS[platform.value] ?? false
  }

  // Picking a service changes what it would do unasked, so the box follows the choice until
  // the operator touches it.
  platform.onchange = () => {
    notifications.checked = PLATFORM_DEFAULT_NOTIFICATIONS[platform.value] ?? false
  }

  showDialog(accountDialog)
}

document.getElementById('add-account').addEventListener('click', () => openAccountForm())

accountDialog.addEventListener('close', () => {
  editedAccountId = null
})

document.getElementById('save-account').addEventListener('click', async (event) => {
  event.preventDefault()
  const data = Object.fromEntries(new FormData(accountDialog.querySelector('form')))

  const result = editedAccountId
    ? await window.mHub.updateAccount(editedAccountId, {
        name: data.name,
        color: data.color,
        notifications: Boolean(data.notifications),
      })
    : await window.mHub.addAccount({ ...data, notifications: Boolean(data.notifications) })

  if (!result.ok) {
    accountErrors.textContent = describeErrors(result.errors)
    return
  }

  editedAccountId = null
  accountDialog.close()
  await refreshRail()
  if (settingsDialog.open) await refreshAccountList()
})

// The panel closes on every choice, so a failed insertion is invisible – every reason
// has to reach the status bar, otherwise it looks exactly like a successful insertion.
const INSERT_REASONS = {
  'no-account': 'messageNoAccount',
  'no-macro': 'messageNoMacro',
  'empty-macro': 'messageEmptyMacro',
}

// The main process returns errors as codes with parameters – only here is it known which
// language the user should read them in.
function describeErrors(errors) {
  return (errors ?? []).map((error) => tr(error.code, error.params)).join('; ')
}

let selectedMacro = 0

// A macro with placeholders is a question before it is an insertion. Nothing is written
// anywhere – not the clipboard, not the page – until the question has an answer, because a
// half-filled message on the clipboard is the one thing that could reach a conversation by
// accident.
const variablesDialog = document.getElementById('variables-dialog')
const variableFields = document.getElementById('variable-fields')

function askForVariables(names) {
  variableFields.replaceChildren()
  for (const name of names) {
    const label = document.createElement('label')
    const caption = document.createElement('span')
    caption.textContent = name
    const input = document.createElement('input')
    input.dataset.variable = name
    input.autocomplete = 'off'
    label.append(caption, input)
    variableFields.append(label)
  }

  return new Promise((resolve) => {
    const finish = (values) => {
      document.getElementById('fill-variables').removeEventListener('click', onFill)
      document.getElementById('cancel-variables').removeEventListener('click', onCancel)
      variablesDialog.removeEventListener('close', onCancel)
      variablesDialog.close()
      resolve(values)
    }
    const onFill = () => {
      const values = {}
      for (const input of variableFields.querySelectorAll('input')) values[input.dataset.variable] = input.value
      finish(values)
    }
    // Escape and the Cancel button mean the same thing, and both mean nothing happened.
    const onCancel = () => finish(null)

    document.getElementById('fill-variables').addEventListener('click', onFill)
    document.getElementById('cancel-variables').addEventListener('click', onCancel)
    variablesDialog.addEventListener('close', onCancel)
    showDialog(variablesDialog)
    variableFields.querySelector('input')?.focus()
  })
}

async function insertMacro(macro) {
  hideMessage()
  macrosDialog.close()

  const names = findVariables(macro.text)
  let values = {}
  if (names.length) {
    values = await askForVariables(names)
    if (!values) return
  }

  const result = await window.mHub.insertMacro(macro.id, values)

  if (result?.ok) {
    // The product promise, said out loud: this app prepares, it does not send.
    const account = railAccounts.find((a) => a.id === activeAccountId)
    showMessage(
      tr('messageInserted', { macro: macro.name, account: account?.name ?? tr('messageTheAccount') }),
      'info',
    )
    return
  }
  if (!result) return

  if (result.missing?.length) {
    showMessage(tr('messageMissingAttachments', { list: result.missing.join(', ') }))
    return
  }
  showMessage(tr(INSERT_REASONS[result.reason] ?? 'messageInsertFailed'))
}

export async function refreshMacros() {
  const macros = await window.mHub.listMacros(macroSearch.value)
  macroList.replaceChildren()

  if (!macros.length) {
    const empty = document.createElement('li')
    empty.className = 'empty'
    empty.textContent = macroSearch.value
      ? tr('nothingMatches', { phrase: macroSearch.value })
      : tr('noMacros')
    macroList.append(empty)
    return
  }

  if (selectedMacro >= macros.length) selectedMacro = 0

  macros.forEach((macro, index) => {
    const row = document.createElement('li')
    const count = (macro.attachments ?? []).length
    row.dataset.macroId = macro.id
    row.setAttribute('aria-selected', String(index === selectedMacro))

    const label = document.createElement('span')
    label.className = 'macro-label'
    label.textContent = count ? tr('macroLabel', { name: macro.name, count }) : macro.name

    // Clicking the row inserts the macro – the most frequent action, so it stays the
    // cheapest. The buttons stop propagation so editing and deleting do not insert
    // the macro on the way.
    row.addEventListener('click', () => insertMacro(macro))

    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'edit-macro'
    edit.textContent = tr('edit')
    edit.title = tr('editMacroTitle', { name: macro.name })
    edit.addEventListener('click', (event) => {
      event.stopPropagation()
      openEditor(macro)
    })

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'remove-macro danger'
    remove.textContent = tr('remove')
    remove.title = tr('removeMacroTitle', { name: macro.name })
    remove.addEventListener('click', (event) => {
      event.stopPropagation()
      confirmMacroRemoval(macro)
    })

    // Tags nobody can see are tags nobody uses, and showing them is also the only
    // explanation the filter needs. Clicking one searches for it, which is exactly what the
    // search box already does – the tag is a shortcut to typing it.
    const tags = document.createElement('span')
    tags.className = 'macro-tags'
    for (const tag of macro.tags ?? []) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'macro-tag'
      chip.textContent = tag
      chip.title = tr('filterByTag', { tag })
      chip.addEventListener('click', (event) => {
        event.stopPropagation()
        macroSearch.value = tag
        selectedMacro = 0
        refreshMacros()
      })
      tags.append(chip)
    }

    row.append(label, tags, edit, remove)
    macroList.append(row)
  })
}

macroSearch.addEventListener('input', () => {
  selectedMacro = 0
  refreshMacros()
})

// Choosing a macro goes by arrows and Enter: with a few dozen entries, reaching for the
// mouse costs more than the insertion itself.
macroSearch.addEventListener('keydown', async (event) => {
  const rows = [...macroList.querySelectorAll('li[data-macro-id]')]
  if (!rows.length) return

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    selectedMacro = (selectedMacro + step + rows.length) % rows.length
    await refreshMacros()
    macroList.querySelector('li[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
    return
  }

  if (event.key === 'Enter') {
    event.preventDefault()
    const macroId = rows[selectedMacro]?.dataset.macroId
    const macros = await window.mHub.listMacros(macroSearch.value)
    const macro = macros.find((m) => m.id === macroId)
    if (macro) await insertMacro(macro)
  }
})

document.getElementById('open-macros').addEventListener('click', async () => {
  macroSearch.value = ''
  selectedMacro = 0
  await refreshMacros()
  showDialog(macrosDialog)
  macroSearch.focus()
})

// The macro panel has no <form method="dialog">, so value="close" alone closes nothing –
// the button needs an explicit handler, exactly as in the settings dialog.
document.getElementById('close-macros').addEventListener('click', (event) => {
  event.preventDefault()
  macrosDialog.close()
})

window.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.key === ';') {
    event.preventDefault()
    document.getElementById('open-macros').click()
  }
})

// The same shortcut pressed while an account view holds focus never reaches the renderer
// at all – the main process intercepts it there and sends the decision back.
window.mHub.onOpenMacros(() => document.getElementById('open-macros').click())

// Spec section 8: a failed start must produce a visible message, not an empty status bar.
// The message MUST be dismissable – otherwise a stale error occupies the bar for the rest
// of the session and the operator keeps reading it long after the cause is fixed.
// An OFFER is something the operator can act on from the bar. Reloading is offered rather
// than done, because it throws away whatever is half-typed in a composer.
let pendingOffer = null
// Which message is on the bar, and the timer that message armed. Both exist for one reason: a
// message may now ask to disappear on its own, and by the time that timer fires the bar can be
// carrying something newer and more important. A timer that cannot prove the message is still
// its own does nothing.
let shownMessageId = null
let hideTimer = null

function showMessage(text, tone = 'error', offer = null, { id = null, autoHideMs = 0 } = {}) {
  const bar = document.getElementById('message')
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
  document.getElementById('message-text').textContent = text
  bar.dataset.tone = tone
  pendingOffer = offer
  shownMessageId = id
  document.getElementById('reload-account').hidden = offer?.action !== 'reload'
  document.getElementById('show-download').hidden = offer?.action !== 'show-download'
  bar.hidden = false
  if (autoHideMs) {
    hideTimer = setTimeout(() => {
      if (shownMessageId === id) hideMessage()
    }, autoHideMs)
  }
}

function hideMessage() {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
  shownMessageId = null
  document.getElementById('message-text').textContent = ''
  document.getElementById('reload-account').hidden = true
  document.getElementById('show-download').hidden = true
  pendingOffer = null
  document.getElementById('message').hidden = true
}

document.getElementById('reload-account').addEventListener('click', async () => {
  const accountId = pendingOffer?.accountId
  hideMessage()
  await window.mHub.reloadAccount(accountId)
})

// The id of a download this process recorded, never a path – main looks up where the file
// actually landed. A page that could name the path could point Explorer anywhere.
document.getElementById('show-download').addEventListener('click', async () => {
  const downloadId = pendingOffer?.downloadId
  hideMessage()
  await window.mHub.showDownload(downloadId)
})

document.getElementById('dismiss-message').addEventListener('click', hideMessage)

// An error raised by an OPEN dialog must not go to the status bar: a modal freezes
// everything around it, so the message would be visible but dead – impossible to dismiss
// and detached from the field it concerns. The account form has had its own error line
// from the start; the macro editor gets one too.
function showMacroError(text) {
  document.getElementById('macro-errors').textContent = text
}

function buildLanguageSelect() {
  languageSelect.replaceChildren()
  for (const { code, name } of availableLanguages()) {
    const option = document.createElement('option')
    option.value = code
    option.textContent = name
    languageSelect.append(option)
  }
  languageSelect.value = language
}

// Changing the language does NOT reload the window – a reload would tear down the native
// account views along with their sign-ins. Instead everything that composes its own text
// is repainted.
async function applyLanguage() {
  translateDocument()
  buildLanguageSelect()
  applyRailState({ pinned: railPinned, expanded: rail.classList.contains('expanded') })
  await refreshRail()
  if (settingsDialog.open) await refreshAccountList()
  if (settingsDialog.open) paintAbout()
  if (macrosDialog.open) await refreshMacros()
}

languageSelect.addEventListener('change', async () => {
  language = validLanguage(await window.mHub.setLanguage(languageSelect.value))
  await applyLanguage()
})

const closeToTrayBox = document.getElementById('close-to-tray')

closeToTrayBox.addEventListener('change', async () => {
  closeToTrayBox.checked = await window.mHub.setCloseToTray(closeToTrayBox.checked)
})

const askWhereToSaveBox = document.getElementById('ask-where-to-save')
const downloadDirField = document.getElementById('download-dir')

// The field shows the RESOLVED folder, so "the system Downloads folder" appears as a path
// rather than as a blank space the operator has to interpret.
function applyDownloadSettings(settings) {
  if (!settings) return
  askWhereToSaveBox.checked = settings.ask
  downloadDirField.textContent = settings.resolved
  downloadDirField.title = settings.resolved
}

askWhereToSaveBox.addEventListener('change', async () => {
  applyDownloadSettings(await window.mHub.setDownloadSettings({ ask: askWhereToSaveBox.checked }))
})

document.getElementById('pick-download-dir').addEventListener('click', async () => {
  // Null means the picker was cancelled, and cancelling is not a decision to change anything.
  applyDownloadSettings(await window.mHub.pickDownloadDir())
})

async function start() {
  try {
    // The language must be known BEFORE the first list is drawn, otherwise the first
    // frame shows English and the second swaps it for Polish.
    language = validLanguage(await window.mHub.getLanguage())
    translateDocument()
    buildLanguageSelect()
    closeToTrayBox.checked = await window.mHub.getCloseToTray()
    applyDownloadSettings(await window.mHub.downloadSettings())
    applyRailState(await window.mHub.railState())
    await refreshRail()
  } catch (error) {
    showMessage(tr('messageLoadAccountsFailed', { reason: error.message }))
  } finally {
    // The ready signal lands only NOW: before this the text was still the English
    // placeholder from the HTML, so a test of the Polish interface would catch the
    // stale frame.
    document.body.dataset.ready = '1'
  }
}

start()

// The unread overlay on the taskbar icon. Electron accepts only a finished image, so the
// renderer draws the 16x16 and sends it back as a data URL. Zero means no overlay.
export function drawUnreadBadge(total) {
  if (!total) return null
  const caption = total > 99 ? '99+' : String(total)
  const canvas = document.createElement('canvas')
  canvas.width = 16
  canvas.height = 16
  const brush = canvas.getContext('2d')
  brush.fillStyle = '#f15c6d'
  brush.beginPath()
  brush.arc(8, 8, 8, 0, Math.PI * 2)
  brush.fill()
  brush.fillStyle = '#ffffff'
  brush.font = `bold ${caption.length > 2 ? 8 : 11}px "Segoe UI", sans-serif`
  brush.textAlign = 'center'
  brush.textBaseline = 'middle'
  brush.fillText(caption, 8, 9)
  return canvas.toDataURL('image/png')
}

// The main process sends the total and the per-account breakdown – the rail shows a count
// on each channel, and the taskbar overlay still needs the total on its own.
let overlayTotal = null

window.mHub.onUnread((data) => {
  const total = typeof data === 'number' ? data : (data?.total ?? 0)
  unreadByAccount = typeof data === 'number' ? {} : (data?.byAccount ?? {})
  refreshUnread()
  // Redrawing the same badge is not free and it is not nothing: setOverlayIcon replaces the
  // image on the taskbar button every time it is called, and this used to be called on every
  // title event a page produced.
  if (total === overlayTotal) return
  overlayTotal = total
  window.mHub.setOverlay(drawUnreadBadge(total))
})

// Messages from the main process (a failed account load, for instance) land on the status
// bar rather than in a modal – one sick account must not block the rest.
window.mHub.onMessage((payload) =>
  showMessage(payload.text, payload.tone ?? 'error', payload.offer, {
    id: payload.id ?? null,
    autoHideMs: payload.autoHideMs ?? 0,
  }),
)

const editorDialog = document.getElementById('editor-dialog')
const editorName = document.getElementById('editor-name')
const editorText = document.getElementById('editor-text')
const editorTags = document.getElementById('editor-tags')
const editorPreview = document.getElementById('editor-preview')

function refreshPreview() {
  editorPreview.innerHTML = toHtml(editorText.value)
}

editorText.addEventListener('input', refreshPreview)

document.getElementById('format-bar').addEventListener('click', (event) => {
  const button = event.target.closest('button')
  if (!button) return
  const start = editorText.selectionStart
  const end = editorText.selectionEnd
  const content = editorText.value

  if (button.dataset.marker) {
    const mark = button.dataset.marker
    const selected = content.slice(start, end) || ''
    editorText.value = content.slice(0, start) + mark + selected + mark + content.slice(end)
    editorText.setSelectionRange(start + mark.length, end + mark.length)
  } else if (button.dataset.prefix) {
    const lineStart = content.lastIndexOf('\n', start - 1) + 1
    editorText.value = content.slice(0, lineStart) + button.dataset.prefix + content.slice(lineStart)
    editorText.setSelectionRange(start + button.dataset.prefix.length, end + button.dataset.prefix.length)
  }

  editorText.focus()
  refreshPreview()
})

// Editing keeps the macro's id even when the name changes – otherwise correcting a name
// would create a second macro next to the old one.
let editedMacroId = null

function openEditor(macro = null) {
  editedMacroId = macro?.id ?? null
  showMacroError('')
  document.getElementById('editor-title').textContent = tr(macro ? 'editMacro' : 'newMacro')
  editorName.value = macro?.name ?? ''
  editorText.value = macro?.text ?? ''
  editorTags.value = formatTags(macro?.tags)
  macroAttachments = [...(macro?.attachments ?? [])]
  refreshAttachments()
  refreshPreview()
  macrosDialog.close()
  showDialog(editorDialog)
}

document.getElementById('new-macro').addEventListener('click', (event) => {
  event.preventDefault()
  openEditor()
})

document.getElementById('cancel-macro').addEventListener('click', (event) => {
  event.preventDefault()
  editorDialog.close()
})

document.getElementById('save-macro').addEventListener('click', async (event) => {
  event.preventDefault()
  showMacroError('')
  const result = await window.mHub.saveMacro({
    ...(editedMacroId ? { id: editedMacroId } : {}),
    name: editorName.value,
    text: editorText.value,
    // Sent on every save, including when it is empty. A save is a partial update, so a field
    // that is never sent can never be cleared – which is how tags used to be lost.
    tags: parseTags(editorTags.value),
    attachments: macroAttachments,
  })
  if (!result.ok) {
    showMacroError(describeErrors(result.errors))
    return
  }
  editedMacroId = null
  editorDialog.close()
})

let macroAttachments = []

// The stored name carries a UUID prefix – the operator only ever sees the original name.
function refreshAttachments() {
  const list = document.getElementById('attachment-list')
  list.replaceChildren()

  if (!macroAttachments.length) {
    const empty = document.createElement('li')
    empty.className = 'empty'
    empty.textContent = tr('none')
    list.append(empty)
    return
  }

  for (const relative of macroAttachments) {
    const row = document.createElement('li')

    const name = document.createElement('span')
    name.className = 'attachment-name'
    name.textContent = relative.replace(/^att\/[0-9a-f-]+-/, '')

    // Detaching only unlinks the attachment from the macro; the file leaves the store on
    // save, so cancelling the editor deletes nothing.
    const detach = document.createElement('button')
    detach.type = 'button'
    detach.className = 'detach-attachment'
    detach.textContent = tr('detach')
    detach.title = tr('detachFile', { name: name.textContent })
    detach.addEventListener('click', () => {
      macroAttachments = macroAttachments.filter((p) => p !== relative)
      refreshAttachments()
    })

    row.append(name, detach)
    list.append(row)
  }
}

document.getElementById('add-attachment').addEventListener('click', async () => {
  showMacroError('')
  const result = await window.mHub.pickFile()
  if (!result) return
  if (result.error) {
    showMacroError(tr('messageAttachmentFailed', { reason: tr(result.error.code, result.error.params) }))
    return
  }
  macroAttachments.push(result)
  refreshAttachments()
})

// Account views are a native layer ABOVE the window content – an open <dialog> hides
// underneath it and only blocks clicks. The layer steps aside while ANY dialog is open.
// The state is computed from the DOM, because a dialog's "close" event is queued rather
// than synchronous: moving from the panel to the editor it would arrive AFTER the editor
// opened and would put the layer back on top.
function refreshViewVisibility() {
  const anyOpen = [...document.querySelectorAll('dialog')].some((d) => d.open)
  window.mHub.setViewsVisible(!anyOpen)
}

function showDialog(dialog) {
  // Calling showModal again on an open dialog throws – and the shortcut can be pressed a
  // second time before the operator notices the panel is already open.
  if (dialog.open) return
  dialog.showModal()
  refreshViewVisibility()
}

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('close', refreshViewVisibility)
}

const settingsDialog = document.getElementById('settings-dialog')
const accountList = document.getElementById('account-list')
const removeAccountDialog = document.getElementById('remove-account-dialog')
let accountToRemove = null

async function refreshAccountList() {
  const accounts = await window.mHub.listAccounts()
  accountList.replaceChildren()

  if (!accounts.length) {
    const empty = document.createElement('li')
    empty.className = 'empty'
    empty.textContent = tr('noAccountsHint')
    accountList.append(empty)
    return
  }

  accounts.forEach((account, index) => {
    const row = document.createElement('li')

    const swatch = document.createElement('span')
    swatch.className = 'account-swatch'
    swatch.style.background = account.color

    const name = document.createElement('span')
    name.className = 'account-name'
    name.textContent = account.name

    const platform = document.createElement('span')
    platform.className = 'account-platform'
    platform.textContent = account.platform

    // Order changes by buttons, not by dragging: native account views sit above the
    // window content and grabbing an element with the mouse tends to be eaten by them.
    const reorder = document.createElement('span')
    reorder.className = 'reorder'

    const up = document.createElement('button')
    up.type = 'button'
    up.className = 'move-up'
    up.textContent = '▲'
    up.title = tr('moveUp', { name: account.name })
    up.disabled = index === 0
    up.addEventListener('click', () => moveAccount(account.id, -1))

    const down = document.createElement('button')
    down.type = 'button'
    down.className = 'move-down'
    down.textContent = '▼'
    down.title = tr('moveDown', { name: account.name })
    down.disabled = index === accounts.length - 1
    down.addEventListener('click', () => moveAccount(account.id, 1))

    reorder.append(up, down)

    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'edit-account'
    edit.textContent = tr('edit')
    edit.title = tr('editAccountTitle', { name: account.name })
    edit.addEventListener('click', () => openAccountForm(account))

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'remove-account danger'
    remove.textContent = tr('remove')
    remove.title = tr('removeAccountTitle', { name: account.name })
    remove.addEventListener('click', () => confirmAccountRemoval(account))

    row.append(swatch, name, platform, reorder, edit, remove)
    accountList.append(row)
  })
}

async function moveAccount(accountId, offset) {
  await window.mHub.moveAccount(accountId, offset)
  await refreshRail()
  await refreshAccountList()
}

document.getElementById('open-settings').addEventListener('click', async () => {
  await refreshAccountList()
  await refreshAbout()
  showDialog(settingsDialog)
})

document.getElementById('close-settings').addEventListener('click', (event) => {
  event.preventDefault()
  settingsDialog.close()
})

document.getElementById('add-account-from-settings').addEventListener('click', () => {
  settingsDialog.close()
  openAccountForm()
})

// The nameplate at the foot of the settings. The facts come from the main process in one
// answer and the size of the profile in another: the walk over a real profile takes the
// better part of a second (843 MB in 3366 files, measured 2026-09-07), so the dialog opens
// on the facts and the number lands when it lands.
let about = null
let profileBytes = null

function paintAbout() {
  if (!about) return
  document.getElementById('about-version').textContent = about.version
  document.getElementById('about-built').textContent = about.buildDate
    ? [about.buildDate, about.commit].filter(Boolean).join(' · ')
    : tr(about.packaged ? 'aboutBuildUnknown' : 'aboutFromSource')
  document.getElementById('about-engine').textContent = `Electron ${about.electron} · Chromium ${about.chrome}`
  const profile = document.getElementById('about-profile')
  profile.textContent = about.profileDir
  profile.title = about.profileDir
  document.getElementById('about-profile-size').textContent =
    profileBytes === null ? '…' : tr('aboutOnDisk', { size: formatBytes(profileBytes, language) })
  document.getElementById('about-license').textContent = about.license
  document.getElementById('open-repository').textContent = about.homepage.replace(/^https?:\/\//, '')
}

async function refreshAbout() {
  about = await window.mHub.about()
  profileBytes = null
  paintAbout()
  window.mHub.profileSize().then((bytes) => {
    profileBytes = bytes
    paintAbout()
  }, () => {})
}

document.getElementById('open-profile').addEventListener('click', () => window.mHub.openProfileFolder())
document.getElementById('open-repository').addEventListener('click', () => window.mHub.openRepository())

// Removing an account clears its session, which signs it out – hence a confirmation
// rather than a bare click. The confirmation opens ON TOP of the settings, so closing it
// returns the operator where they came from, with a refreshed list.
function confirmAccountRemoval(account) {
  accountToRemove = account
  document.getElementById('remove-account-text').textContent = tr('accountWillDisappear', { name: account.name })
  showDialog(removeAccountDialog)
}

document.getElementById('cancel-remove-account').addEventListener('click', (event) => {
  event.preventDefault()
  accountToRemove = null
  removeAccountDialog.close()
})

document.getElementById('confirm-remove-account').addEventListener('click', async (event) => {
  event.preventDefault()
  hideMessage()
  if (!accountToRemove) return
  const result = await window.mHub.removeAccount(accountToRemove.id)
  accountToRemove = null
  removeAccountDialog.close()
  if (!result.ok) {
    showMessage(describeErrors(result.errors))
    return
  }
  await refreshRail()
  await refreshAccountList()
})

// Removing a macro also deletes its attachments from the store, so it too asks first –
// exactly as accounts do.
const removeMacroDialog = document.getElementById('remove-macro-dialog')
let macroToRemove = null

function confirmMacroRemoval(macro) {
  macroToRemove = macro
  const count = (macro.attachments ?? []).length
  document.getElementById('remove-macro-text').textContent = count
    ? tr('macroWillDisappearWithAttachments', { name: macro.name, count })
    : tr('macroWillDisappear', { name: macro.name })
  showDialog(removeMacroDialog)
}

document.getElementById('cancel-remove-macro').addEventListener('click', (event) => {
  event.preventDefault()
  macroToRemove = null
  removeMacroDialog.close()
})

document.getElementById('confirm-remove-macro').addEventListener('click', async (event) => {
  event.preventDefault()
  hideMessage()
  if (!macroToRemove) return
  const result = await window.mHub.removeMacro(macroToRemove.id)
  macroToRemove = null
  removeMacroDialog.close()
  if (!result.ok) {
    showMessage(describeErrors(result.errors))
    return
  }
  await refreshMacros()
})
