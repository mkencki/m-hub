import { ipcMain, clipboard, dialog, session } from 'electron'
import path from 'node:path'
import { access } from 'node:fs/promises'
import {
  loadAccounts,
  saveAccounts,
  validateAccount,
  makeAccountId,
  updateAccount,
  moveAccount,
  unusedColor,
  PLATFORMS,
} from './accounts.js'
import {
  loadMacros,
  saveMacros,
  search,
  makeMacroId,
  addAttachment,
  upsert,
  removeOrphanAttachments,
} from './macros.js'
import { insertText } from './insertion.js'
import { fillVariables } from '../shared/variables.js'

export function registerAccountChannels({
  dataDir,
  manager,
  onAccountsChanged,
  prepareView = () => {},
  onAccountShown = () => {},
  wakeAccount = async () => false,
  onAccountRemoved = () => {},
}) {
  const accountsFile = path.join(dataDir, 'accounts.json')

  ipcMain.handle('accounts:list', async () => (await loadAccounts(accountsFile)).accounts)

  ipcMain.handle('accounts:add', async (_event, data) => {
    const { accounts } = await loadAccounts(accountsFile)
    const platform = PLATFORMS[data.platform]
    const account = {
      id: makeAccountId(data.name, accounts.map((a) => a.id)),
      name: String(data.name || '').trim(),
      platform: data.platform,
      url: data.url || platform?.url || '',
      color: data.color || '#2f7d5b',
      // Only written when the form said something; absent means "whatever this platform does
      // by default", which is what every account written before the setting existed relies on.
      ...(data.notifications === undefined ? {} : { notifications: Boolean(data.notifications) }),
    }
    const errors = validateAccount(account)
    if (errors.length) return { ok: false, errors }
    await saveAccounts(accountsFile, [...accounts, account])
    // An account added while the app is running gets the same treatment as accounts
    // present at startup: notification permission and unread-count tracking.
    prepareView(manager.add(account), account)
    onAccountsChanged()
    return { ok: true }
  })

  ipcMain.handle('accounts:remove', async (_event, accountId) => {
    const { accounts } = await loadAccounts(accountsFile)
    const remaining = accounts.filter((a) => a.id !== accountId)
    if (remaining.length === accounts.length) {
      return { ok: false, errors: [{ code: 'validationNoSuchAccount', params: {} }] }
    }

    await saveAccounts(accountsFile, remaining)
    manager.remove(accountId)
    onAccountRemoved(accountId)

    // Without clearing the partition the sign-in stays on disk and would come back
    // if an account with the same id were ever created again.
    await session.fromPartition(`persist:${accountId}`).clearStorageData()

    onAccountsChanged()
    return { ok: true }
  })

  ipcMain.handle('accounts:unused-color', async () => unusedColor((await loadAccounts(accountsFile)).accounts))

  ipcMain.handle('accounts:update', async (_event, accountId, changes) => {
    const { accounts } = await loadAccounts(accountsFile)
    const result = updateAccount(accounts, accountId, changes)
    if (!result.ok) return result

    // Neither the view nor the partition is touched: the id stays the same, so the
    // sign-in lives on. The manager is told, though – it names the account in the channel menu.
    await saveAccounts(accountsFile, result.accounts)
    const updated = result.accounts.find((a) => a.id === accountId)
    if (updated) manager.update(updated)
    return { ok: true }
  })

  ipcMain.handle('accounts:move', async (_event, accountId, offset) => {
    const { accounts } = await loadAccounts(accountsFile)
    // Order in the file is the order of the channels – the rail rebuilds itself from it.
    await saveAccounts(accountsFile, moveAccount(accounts, accountId, offset))
    return { ok: true }
  })

  ipcMain.handle('views:visibility', (_event, visible) => {
    manager.setVisibility(visible)
  })

  const switchTo = switchAccountHandler({ manager, wakeAccount, onAccountShown })
  ipcMain.handle('accounts:switch', (_event, accountId) => switchTo(accountId))
}

// The status bar's Back and Forward belong to the account in front, so they are told where the
// new one can go the moment it is shown.
//
// A sleeping account is woken first. One place for a click on its channel and for Ctrl+1..9,
// which both come here through the renderer – choosing an account is asking for its page.
// Waking takes a moment, and a choice made meanwhile is the later word: the switch it overtook
// shows nothing when its account is finally awake.
export function switchAccountHandler({ manager, wakeAccount, onAccountShown }) {
  let latest = 0
  return async (accountId) => {
    const turn = ++latest
    if (manager.isAsleep(accountId) || manager.isFallingAsleep(accountId)) await wakeAccount(accountId)
    if (turn !== latest) return
    manager.show(accountId)
    onAccountShown(accountId)
  }
}


// Spec section 8: a file missing from the store must not sink the macro – the text has to
// work, and the interface has to say which attachments are missing.
//
// A clipboard that refuses is the same kind of failure and gets the same answer. It used to
// be neither caught nor reported: the rejection escaped the IPC handler, the operator was
// told nothing, and the attachments after the failed one were never even attempted. Whether
// the file is absent from disk or the clipboard would not take it, the operator needs the
// same sentence – that one did not go in.
export async function pasteAttachments({ attachments, dataDir, clipboardSession, view, reach = access }) {
  const missing = []
  for (const relative of attachments) {
    const full = path.join(dataDir, relative)
    try {
      await reach(full)
    } catch {
      missing.push(relative)
      continue
    }
    try {
      await clipboardSession.setFile(full)
    } catch {
      missing.push(relative)
      continue
    }
    view.webContents.paste()
  }
  return { missing }
}

export function registerMacroChannels({ dataDir, manager, clipboardSession }) {
  const macrosFile = path.join(dataDir, 'macros.json')
  const attDir = path.join(dataDir, 'att')

  ipcMain.handle('macros:list', async (_event, phrase) => {
    const { macros } = await loadMacros(macrosFile)
    return search(macros, phrase)
  })

  ipcMain.handle('macros:save', async (_event, macro) => {
    if (!String(macro?.name || '').trim()) {
      return { ok: false, errors: [{ code: 'validationName', params: {} }] }
    }
    const { macros } = await loadMacros(macrosFile)
    const id = macro.id || makeMacroId(macro.name)
    // A save is a PARTIAL update: whatever the caller does not send falls back to what is
    // already stored, never to an empty default. The editor sends name, text and
    // attachments and has never sent `tags`, because no screen sets them – so the bare
    // `tags: []` default used to win on every save and quietly emptied the field. A macro
    // saved with tags stopped being findable by them after one unrelated edit, while the
    // palette's own search box promises "name, content or tag". Clearing a field still
    // works; it just has to be asked for, by sending it explicitly empty.
    const stored = macros.find((m) => m.id === id)
    const saved = upsert(macros, { attachments: [], tags: [], ...stored, ...macro, id })
    await saveMacros(macrosFile, saved)
    // An attachment detached in the editor is no longer used – without this sweep it
    // would sit in the store forever, and that is often several megabytes of video.
    await removeOrphanAttachments(attDir, saved)
    return { ok: true, id }
  })

  ipcMain.handle('macros:remove', async (_event, macroId) => {
    const { macros } = await loadMacros(macrosFile)
    const remaining = macros.filter((m) => m.id !== macroId)
    if (remaining.length === macros.length) {
      return { ok: false, errors: [{ code: 'validationNoSuchMacro', params: {} }] }
    }
    await saveMacros(macrosFile, remaining)
    await removeOrphanAttachments(attDir, remaining)
    return { ok: true }
  })

  ipcMain.handle('macros:insert', async (_event, macroId, values) => {
    const { macros } = await loadMacros(macrosFile)
    const macro = macros.find((m) => m.id === macroId)

    // Every failure carries a named reason. Without one the panel simply vanished and
    // the operator could not tell whether the macro went in – and it had not.
    if (!macro) return { ok: false, reason: 'no-macro', missing: [] }

    const view = manager.active()
    if (!view) return { ok: false, reason: 'no-account', missing: [] }

    const attachments = macro.attachments ?? []
    if (!macro.text && !attachments.length) {
      return { ok: false, reason: 'empty-macro', missing: [] }
    }

    // Placeholders are filled HERE, on the way to the clipboard, so nothing downstream has
    // to know about them: insertion.js still writes the string it is handed. A macro with no
    // placeholders comes through this untouched, which is the path every macro that exists
    // today takes.
    const text = fillVariables(macro.text, values ?? {})
    if (text) insertText(view.webContents, text, clipboard)

    const { missing } = await pasteAttachments({ attachments, dataDir, clipboardSession, view })

    // Ctrl+; deliberately moves the keyboard to the renderer, or the palette opens and cannot
    // be typed in. Getting it back was left to whatever closing a <dialog> happens to do, and
    // that turns out to depend on which webContents held focus when the dialog opened –
    // measured 2026-08-25: with the window brought to the front first the view gets it back,
    // without that the renderer keeps it. The most frequent action in this application cannot
    // rest on which of those two states the operator happens to be in, so it is asked for.
    if (!view.webContents.isDestroyed()) view.webContents.focus()

    return {
      ok: missing.length === 0,
      reason: missing.length ? 'missing-files' : null,
      missing,
    }
  })

  ipcMain.handle('files:pick', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'] })
    if (result.canceled || !result.filePaths.length) return null
    try {
      return await addAttachment(attDir, result.filePaths[0])
    } catch (error) {
      // A code, not a sentence – the renderer owns the language. See accounts.js.
      return { error: { code: error.code ?? 'attachmentFailed', params: error.params ?? {} } }
    }
  })
}
