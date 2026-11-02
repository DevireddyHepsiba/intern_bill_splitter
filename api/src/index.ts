import { type Context, Hono } from 'hono'

type SqlValue = string | number | null | boolean | ArrayBuffer | ArrayBufferView
type DatabaseStatement = {
  bind(...values: SqlValue[]): DatabaseStatement
  run(): Promise<{ success: boolean; meta: { changes: number } }>
  first<Row>(): Promise<Row | null>
  all<Row>(): Promise<{ results: Row[] }>
}
type WorkerDatabase = {
  prepare(query: string): DatabaseStatement
  batch(statements: DatabaseStatement[]): Promise<unknown[]>
}
type Bindings = { DB: WorkerDatabase }
type IdRow = { id: string }
type MemberRow = { id: string; home_id: string; name: string }
type BillRow = { id: string; home_id: string; title: string; total_cents: number }
type ShareRow = {
  id: string
  bill_id: string
  member_id: string
  amount_cents: number
  paid_at: string | null
  idempotency_key: string | null
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.post('/api/homes', async (c) => {
  const body = await readBody(c)
  if (!body.ok) return c.json({ error: 'Invalid JSON body' }, 400)
  const name = nonEmptyString(body.value.name)
  if (!name) return c.json({ error: 'Name is required' }, 422)

  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)').bind(id, name).run()
  return c.json({ id, name }, 201)
})

app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<IdRow>()
  if (!home) return c.json({ error: 'Home not found' }, 404)
  const body = await readBody(c)
  if (!body.ok) return c.json({ error: 'Invalid JSON body' }, 400)
  const name = nonEmptyString(body.value.name)
  if (!name) return c.json({ error: 'Name is required' }, 422)

  const id = crypto.randomUUID()
  const inserted = await c.env.DB.prepare(
    `INSERT INTO members (id, home_id, name, member_order)
     SELECT ?, ?, ?, COALESCE(MAX(member_order), -1) + 1 FROM members WHERE home_id = ?`,
  )
    .bind(id, homeId, name, homeId)
    .run()
  if (!inserted.success) return c.json({ error: 'Could not add member' }, 500)
  return c.json({ id, homeId, name }, 201)
})

app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<IdRow>()
  if (!home) return c.json({ error: 'Home not found' }, 404)
  const body = await readBody(c)
  if (!body.ok) return c.json({ error: 'Invalid JSON body' }, 400)
  const title = nonEmptyString(body.value.title)
  const totalCents = body.value.totalCents
  if (
    !title ||
    typeof totalCents !== 'number' ||
    !Number.isSafeInteger(totalCents) ||
    totalCents <= 0
  ) {
    return c.json({ error: 'Title and a positive whole number of cents are required' }, 422)
  }

  const members = await c.env.DB.prepare(
    'SELECT id FROM members WHERE home_id = ? ORDER BY member_order ASC',
  )
    .bind(homeId)
    .all<Pick<MemberRow, 'id'>>()
  if (members.results.length === 0) return c.json({ error: 'Home has no members' }, 422)

  const billId = crypto.randomUUID()
  const count = members.results.length
  const base = Math.floor(totalCents / count)
  const remainder = totalCents % count
  const shares = members.results.map((member, index) => ({
    id: crypto.randomUUID(),
    memberId: member.id,
    amountCents: base + (index < remainder ? 1 : 0),
    paidAt: null,
  }))
  const statements = [
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)',
    ).bind(billId, homeId, title, totalCents),
    ...shares.map((share) =>
      c.env.DB.prepare(
        'INSERT INTO shares (id, bill_id, home_id, member_id, amount_cents) VALUES (?, ?, ?, ?, ?)',
      ).bind(share.id, billId, homeId, share.memberId, share.amountCents),
    ),
  ]
  await c.env.DB.batch(statements)
  return c.json({ id: billId, homeId, title, totalCents, shares }, 201)
})

app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<IdRow>()
  if (!home) return c.json({ error: 'Home not found' }, 404)
  const result = await c.env.DB.prepare(
    `SELECT b.id, b.home_id, b.title, b.total_cents,
            s.id AS share_id, s.member_id, s.amount_cents, s.paid_at,
            m.name AS member_name
     FROM bills b
     JOIN shares s ON s.bill_id = b.id
     JOIN members m ON m.id = s.member_id
     WHERE b.home_id = ?
     ORDER BY b.rowid DESC, m.member_order ASC`,
  )
    .bind(homeId)
    .all<
      BillRow & {
        share_id: string
        member_id: string
        amount_cents: number
        paid_at: string | null
        member_name: string
      }
    >()
  const byId = new Map<
    string,
    BillRow & {
      shares: Array<{
        id: string
        memberId: string
        memberName: string
        amountCents: number
        paidAt: string | null
      }>
    }
  >()
  for (const row of result.results) {
    let bill = byId.get(row.id)
    if (!bill) {
      bill = {
        id: row.id,
        home_id: row.home_id,
        title: row.title,
        total_cents: row.total_cents,
        shares: [],
      }
      byId.set(row.id, bill)
    }
    bill.shares.push({
      id: row.share_id,
      memberId: row.member_id,
      memberName: row.member_name,
      amountCents: row.amount_cents,
      paidAt: row.paid_at,
    })
  }
  return c.json({
    bills: [...byId.values()].map(({ id, home_id, title, total_cents, shares }) => ({
      id,
      homeId: home_id,
      title,
      totalCents: total_cents,
      shares,
    })),
  })
})

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const key = c.req.header('Idempotency-Key')?.trim()
  if (!key) return c.json({ error: 'Idempotency-Key header is required' }, 400)
  const { billId, shareId } = c.req.param()
  const share = await c.env.DB.prepare(
    `SELECT s.id, s.bill_id, s.member_id, s.amount_cents, s.paid_at, s.idempotency_key
     FROM shares s JOIN bills b ON b.id = s.bill_id
     WHERE b.id = ? AND s.id = ?`,
  )
    .bind(billId, shareId)
    .first<ShareRow>()
  if (!share) return c.json({ error: 'Bill or share not found' }, 404)

  if (share.paid_at !== null) {
    if (share.idempotency_key === key) {
      return c.json({
        id: share.id,
        memberId: share.member_id,
        amountCents: share.amount_cents,
        paidAt: share.paid_at,
      })
    }
    return c.json({ error: 'Share already paid' }, 409)
  }

  const paidAt = new Date().toISOString()
  const update = await c.env.DB.prepare(
    `UPDATE shares SET paid_at = ?, idempotency_key = ?
     WHERE id = ? AND bill_id = ? AND paid_at IS NULL`,
  )
    .bind(paidAt, key, shareId, billId)
    .run()
  if (update.meta.changes === 1) {
    return c.json({
      id: share.id,
      memberId: share.member_id,
      amountCents: share.amount_cents,
      paidAt,
    })
  }

  // Another request won the conditional update. Read its committed result to
  // distinguish a retry from a competing payment using a different key.
  const current = await c.env.DB.prepare(
    'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ? AND bill_id = ?',
  )
    .bind(shareId, billId)
    .first<ShareRow>()
  if (!current) return c.json({ error: 'Bill or share not found' }, 404)
  if (current.paid_at !== null && current.idempotency_key === key) {
    return c.json({
      id: current.id,
      memberId: current.member_id,
      amountCents: current.amount_cents,
      paidAt: current.paid_at,
    })
  }
  return c.json({ error: 'Share already paid' }, 409)
})

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<IdRow>()
  if (!home) return c.json({ error: 'Home not found' }, 404)
  const result = await c.env.DB.prepare(
    `SELECT m.id AS member_id, m.name,
            COALESCE(SUM(CASE WHEN s.paid_at IS NULL AND b.home_id = m.home_id THEN s.amount_cents ELSE 0 END), 0) AS outstanding_cents
     FROM members m
     LEFT JOIN shares s ON s.member_id = m.id
     LEFT JOIN bills b ON b.id = s.bill_id AND b.home_id = m.home_id
     WHERE m.home_id = ?
     GROUP BY m.id, m.name, m.member_order
     ORDER BY m.member_order ASC`,
  )
    .bind(homeId)
    .all<{ member_id: string; name: string; outstanding_cents: number }>()
  return c.json({
    balances: result.results.map((row) => ({
      memberId: row.member_id,
      name: row.name,
      outstandingCents: row.outstanding_cents,
    })),
  })
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))
app.onError((error, c) => {
  console.error('Request failed', error)
  return c.json({ error: 'Internal server error' }, 500)
})

async function readBody(
  c: Context<{ Bindings: Bindings }>,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  try {
    const value: unknown = await c.req.json()
    if (!isObjectRecord(value)) return { ok: false }
    return { ok: true, value }
  } catch {
    return { ok: false }
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export default app
