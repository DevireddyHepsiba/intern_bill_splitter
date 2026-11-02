import { createFileRoute } from '@tanstack/react-router'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import './index.css'

export const Route = createFileRoute('/')({ component: Home })

type Share = {
  id: string
  memberId: string
  memberName: string
  amountCents: number
  paidAt: string | null
}
type Bill = { id: string; title: string; totalCents: number; shares: Share[] }
type Balance = { memberId: string; name: string; outstandingCents: number }
type BillResponse = { bills: Bill[] }
type BalanceResponse = { balances: Balance[] }

function Home() {
  const initialHomeId = new URLSearchParams(window.location.search).get('homeId') ?? ''
  const [homeInput, setHomeInput] = useState(initialHomeId)
  const [homeId, setHomeId] = useState(initialHomeId)
  const [bills, setBills] = useState<Bill[]>([])
  const [balances, setBalances] = useState<Balance[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [paymentErrors, setPaymentErrors] = useState<Record<string, string>>({})
  const [paying, setPaying] = useState<Record<string, boolean>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const requestVersion = useRef(0)
  const activeHomeId = useRef(initialHomeId)
  const paymentKeys = useRef(new Map<string, string>())
  const activePayments = useRef(new Set<string>())
  const paymentControllers = useRef(new Set<AbortController>())

  const reload = useCallback(async (id: string, signal?: AbortSignal) => {
    const [billPayload, balancePayload] = await Promise.all([
      requestJson(`/api/homes/${encodeURIComponent(id)}/bills`, signal),
      requestJson(`/api/homes/${encodeURIComponent(id)}/balances`, signal),
    ])
    if (!isBillResponse(billPayload) || !isBalanceResponse(balancePayload)) {
      throw new Error('The server returned data in an unexpected format.')
    }
    return { bills: billPayload.bills, balances: balancePayload.balances }
  }, [])

  useEffect(() => {
    if (!homeId) {
      setBills([])
      setBalances([])
      setLoadError(null)
      return
    }
    const version = ++requestVersion.current
    const retryAtStart = reloadToken
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    setLoading(true)
    setLoadError(null)
    setBills([])
    setBalances([])
    void reload(homeId, controller.signal)
      .then((data) => {
        if (requestVersion.current !== version || reloadToken !== retryAtStart) return
        setBills(data.bills)
        setBalances(data.balances)
      })
      .catch((error: unknown) => {
        if (
          requestVersion.current !== version ||
          reloadToken !== retryAtStart ||
          controller.signal.aborted
        ) {
          if (
            controller.signal.aborted &&
            requestVersion.current === version &&
            reloadToken === retryAtStart
          ) {
            setLoadError('The request took too long. Check your connection and try again.')
          }
          return
        }
        setLoadError(errorMessage(error))
      })
      .finally(() => {
        window.clearTimeout(timeout)
        if (requestVersion.current === version && reloadToken === retryAtStart) setLoading(false)
      })
    return () => {
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [homeId, reload, reloadToken])

  useEffect(
    () => () => {
      for (const controller of paymentControllers.current) controller.abort()
      paymentControllers.current.clear()
    },
    [],
  )

  async function refreshAfterPayment(id: string, signal?: AbortSignal): Promise<boolean> {
    setRefreshing(true)
    try {
      const data = await reload(id, signal)
      if (activeHomeId.current === id) {
        setBills(data.bills)
        setBalances(data.balances)
      }
      return true
    } catch (error: unknown) {
      if (activeHomeId.current === id)
        setLoadError(`Payment succeeded, but refreshing failed: ${errorMessage(error)}`)
      return false
    } finally {
      if (activeHomeId.current === id) setRefreshing(false)
    }
  }

  async function payShare(billId: string, shareId: string) {
    const keyId = `${billId}:${shareId}`
    if (activePayments.current.has(keyId)) return
    activePayments.current.add(keyId)
    const idempotencyKey = paymentKeys.current.get(keyId) ?? crypto.randomUUID()
    paymentKeys.current.set(keyId, idempotencyKey)
    setPaying((current) => ({ ...current, [keyId]: true }))
    setPaymentErrors((current) => ({ ...current, [keyId]: '' }))
    setNotice(null)
    const controller = new AbortController()
    paymentControllers.current.add(controller)
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    try {
      const result = await requestJson(
        `/api/bills/${encodeURIComponent(billId)}/shares/${encodeURIComponent(shareId)}/pay`,
        controller.signal,
        { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } },
      )
      if (!isPaidShare(result))
        throw new Error('The server returned an unexpected payment response.')
      setNotice('Payment recorded successfully.')
      const refreshed = await refreshAfterPayment(homeId, controller.signal)
      if (refreshed) paymentKeys.current.delete(keyId)
    } catch (error: unknown) {
      const message = controller.signal.aborted
        ? 'The payment request timed out. Retry safely; the same request key will be reused.'
        : errorMessage(error)
      setPaymentErrors((current) => ({ ...current, [keyId]: message }))
    } finally {
      window.clearTimeout(timeout)
      paymentControllers.current.delete(controller)
      activePayments.current.delete(keyId)
      setPaying((current) => ({ ...current, [keyId]: false }))
    }
  }

  function loadHome(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const id = homeInput.trim()
    activeHomeId.current = id
    setNotice(null)
    setHomeId(id)
    if (id) {
      const url = new URL(window.location.href)
      url.searchParams.set('homeId', id)
      window.history.replaceState({}, '', url)
    }
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="HomeLedger home">
          <span className="brand-mark">H</span> homeledger
        </a>
        <span className="topbar-label">
          <span className="online-dot" /> Shared home workspace
        </span>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">HOUSEHOLD FINANCES, MADE SIMPLE</span>
          <h1>
            Good bills.
            <br />
            <em>Clear splits.</em>
          </h1>
          <p>See what the household owes, all in one place.</p>
        </div>
        <div className="hero-note">
          <span className="note-spark">✳</span>
          <span>
            Every cent
            <br />
            has a place.
          </span>
        </div>
        <div className="hero-orb" aria-hidden="true" />
      </section>

      <section className="content">
        <form className="home-picker" onSubmit={loadHome}>
          <label htmlFor="home-id">Your home</label>
          <div className="picker-row">
            <input
              id="home-id"
              value={homeInput}
              onChange={(event) => setHomeInput(event.target.value)}
              placeholder="Paste your home ID"
              autoComplete="off"
            />
            <button type="submit" className="button button-dark">
              View home <span aria-hidden="true">→</span>
            </button>
          </div>
          <p className="field-hint">Use the ID returned when your home was created.</p>
        </form>

        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {loadError && (
          <div className="error-banner" role="alert">
            <span>{loadError}</span>
            <button type="button" onClick={() => setReloadToken((token) => token + 1)}>
              Try again
            </button>
          </div>
        )}

        <div className="section-heading">
          <div>
            <span className="eyebrow">AT A GLANCE</span>
            <h2>Outstanding balances</h2>
          </div>
          <span className="section-count">
            {homeId ? `${balances.length} ${balances.length === 1 ? 'member' : 'members'}` : '—'}
          </span>
        </div>
        {loading ? (
          <div className="skeleton balance-skeleton" role="status" aria-label="Loading balances" />
        ) : homeId && balances.length > 0 ? (
          <div className="balance-grid">
            {balances.map((balance, index) => (
              <article className="balance-card" key={balance.memberId}>
                <div className={`avatar avatar-${index % 4}`}>{initials(balance.name)}</div>
                <div className="balance-person">
                  <span>{balance.name}</span>
                  <small>Outstanding</small>
                </div>
                <strong>{formatMoney(balance.outstandingCents)}</strong>
              </article>
            ))}
          </div>
        ) : homeId && !loadError ? (
          <p className="empty-inline">No members in this home yet.</p>
        ) : (
          <p className="empty-inline">Enter a home ID to see balances.</p>
        )}

        <div className="section-heading bills-heading">
          <div>
            <span className="eyebrow">THE DETAILS</span>
            <h2>Recent bills</h2>
          </div>
          {refreshing && <span className="refresh-label">Updating…</span>}
        </div>
        {loading ? (
          <div className="bill-skeletons">
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        ) : !homeId ? (
          <div className="empty-card">
            <span className="empty-icon">▤</span>
            <h3>Your bills will show up here</h3>
            <p>Enter a home ID above to get started.</p>
          </div>
        ) : loadError && bills.length === 0 ? (
          <div className="empty-card">
            <span className="empty-icon">↻</span>
            <h3>We couldn’t load these bills</h3>
            <p>Check your connection and try again.</p>
          </div>
        ) : bills.length === 0 ? (
          <div className="empty-card">
            <span className="empty-icon">✳</span>
            <h3>No bills just yet</h3>
            <p>New household bills will appear here.</p>
          </div>
        ) : (
          <div className="bill-list">
            {bills.map((bill, index) => (
              <article className="bill-card" key={bill.id}>
                <div className="bill-topline">
                  <div className="bill-icon">{billIcon(index)}</div>
                  <div className="bill-title">
                    <h3>{bill.title}</h3>
                    <span>
                      {bill.shares.length} {bill.shares.length === 1 ? 'share' : 'shares'}
                    </span>
                  </div>
                  <strong className="bill-total">{formatMoney(bill.totalCents)}</strong>
                </div>
                <div className="share-list">
                  {bill.shares.map((share) => {
                    const keyId = `${bill.id}:${share.id}`
                    const pending = paying[keyId] === true
                    const error = paymentErrors[keyId]
                    return (
                      <div className="share-row" key={share.id}>
                        <div className="share-person">
                          <span className={`mini-avatar avatar-${hash(share.memberName) % 4}`}>
                            {initials(share.memberName)}
                          </span>
                          <span>{share.memberName}</span>
                        </div>
                        <span className="share-amount">{formatMoney(share.amountCents)}</span>
                        {share.paidAt ? (
                          <span className="paid-badge">
                            <span>✓</span> Paid
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="button button-pay"
                            onClick={() => void payShare(bill.id, share.id)}
                            disabled={pending}
                            aria-label={`Pay ${formatMoney(share.amountCents)} share for ${share.memberName}`}
                          >
                            {pending ? 'Paying…' : 'Mark paid'}
                          </button>
                        )}
                        {error && (
                          <p className="payment-error" role="alert">
                            {error}
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <footer className="footer">
        <span>homeledger</span>
        <span>Made for sharing, built for clarity.</span>
      </footer>
    </main>
  )
}

async function requestJson(
  url: string,
  signal?: AbortSignal,
  init?: RequestInit,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      signal,
      headers: { Accept: 'application/json', ...init?.headers },
    })
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error('Could not reach the server. Check that the API is running.')
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error(
      response.ok ? 'The server returned invalid data.' : `Request failed (${response.status}).`,
    )
  }
  if (!response.ok) {
    const message = isErrorResponse(payload)
      ? payload.error
      : `Request failed (${response.status}).`
    throw new Error(message)
  }
  return payload
}

function isBillResponse(value: unknown): value is BillResponse {
  if (!isRecord(value) || !Array.isArray(value.bills)) return false
  return value.bills.every(
    (bill) =>
      isRecord(bill) &&
      typeof bill.id === 'string' &&
      typeof bill.title === 'string' &&
      Number.isSafeInteger(bill.totalCents) &&
      Array.isArray(bill.shares) &&
      bill.shares.every(
        (share) =>
          isRecord(share) &&
          typeof share.id === 'string' &&
          typeof share.memberId === 'string' &&
          typeof share.memberName === 'string' &&
          Number.isSafeInteger(share.amountCents) &&
          (typeof share.paidAt === 'string' || share.paidAt === null),
      ),
  )
}

function isBalanceResponse(value: unknown): value is BalanceResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.balances) &&
    value.balances.every(
      (row) =>
        isRecord(row) &&
        typeof row.memberId === 'string' &&
        typeof row.name === 'string' &&
        Number.isSafeInteger(row.outstandingCents),
    )
  )
}

function isPaidShare(
  value: unknown,
): value is { id: string; memberId: string; amountCents: number; paidAt: string } {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.memberId === 'string' &&
    Number.isSafeInteger(value.amountCents) &&
    typeof value.paidAt === 'string'
  )
}

function isErrorResponse(value: unknown): value is { error: string } {
  return isRecord(value) && typeof value.error === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(
    cents / 100,
  )
}

function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('') || '?'
  )
}

function hash(value: string): number {
  return [...value].reduce((result, character) => result + character.charCodeAt(0), 0)
}

function billIcon(index: number): string {
  return ['⌂', 'ϟ', '✳', '◌'][index % 4] ?? '⌂'
}
