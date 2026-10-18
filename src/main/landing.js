// Loads an address into a webContents and answers whether the page got there: yes once the main
// frame has committed it, no when the page in front refuses to be left, an error page stands in for
// it, or loading stops without a commit.
//
// Not by the promise loadURL returns. That promise fails on the first failure the main frame
// reports after it was asked, whichever page the failure is about – and the page being left
// reports its own unfinished load as aborted when the new one cuts it short, sometimes at once and
// sometimes only after the new page is in (measured on CI, run 39074653622). It also succeeds on
// the page in front rewriting its own address before the new load has started. A move judged by it
// can bring back a window whose page had arrived, or close one whose page never did.
//
// The two cases told apart here: Electron reports a refusal to leave as an abort of the very
// address that was asked for, and an error page with an error of its own; the page being left
// reports an abort of its own address.

const ABORTED = -3

export function loadAndLand(contents, address) {
  return new Promise((answer) => {
    const committed = () => settle(true)
    const steppedWithin = (_event, url, isMainFrame) => {
      if (isMainFrame && url === address) settle(true)
    }
    const failed = (_event, code, _description, url, isMainFrame) => {
      if (isMainFrame && (code !== ABORTED || url === address)) settle(false)
    }
    const stopped = () => settle(false)

    const listeners = {
      'did-navigate': committed,
      'did-navigate-in-page': steppedWithin,
      'did-fail-load': failed,
      'did-stop-loading': stopped,
      destroyed: stopped,
    }
    const settle = (landed) => {
      for (const [name, listener] of Object.entries(listeners)) contents.removeListener(name, listener)
      answer(landed)
    }

    // Listening first: the first reports of a load can arrive before loadURL returns.
    for (const [name, listener] of Object.entries(listeners)) contents.on(name, listener)
    contents.loadURL(address).catch(() => {})
  })
}
