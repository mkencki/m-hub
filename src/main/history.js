// One step through a page's history, for an account view and for a window a page opened alike.
//
// Only ever through navigationHistory.goBack and goForward, and only where canGoBack and
// canGoForward say there is somewhere to go. Chromium answers "no" for entries a page added before
// anybody touched it – the way a page builds a trap that Back cannot leave – and goToOffset would
// walk into them anyway. A disabled Back right after a cold start of Facebook can therefore be the
// right answer, and it is not "fixed" here.
//
// A step does not pass through will-navigate. That is safe: the history holds only entries the
// page has already committed, each of which got where it is past the navigation rules once.

export function historyState(contents) {
  const history = contents.navigationHistory
  return { canGoBack: history.canGoBack(), canGoForward: history.canGoForward() }
}

export function step(contents, direction) {
  const history = contents.navigationHistory
  if (direction === 'back' && history.canGoBack()) {
    history.goBack()
    return true
  }
  if (direction === 'forward' && history.canGoForward()) {
    history.goForward()
    return true
  }
  return false
}
