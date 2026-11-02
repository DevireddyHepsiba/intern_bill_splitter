import { describe, expect, it } from 'vitest'
import { call, createBill, createHome, type Share } from './helpers'

describe('edge cases', () => {
  it('trims names and rejects whitespace-only names', async () => {
    const home = await call<{ id: string; name: string }>('POST', '/api/homes', {
      body: { name: '  Shared home  ' },
    })
    expect(home.status).toBe(201)
    expect(home.body.name).toBe('Shared home')

    const member = await call<{ id: string; homeId: string; name: string }>(
      'POST',
      `/api/homes/${home.body.id}/members`,
      { body: { name: '  Asha  ' } },
    )
    expect(member.status).toBe(201)
    expect(member.body.name).toBe('Asha')

    const blank = await call('POST', `/api/homes/${home.body.id}/members`, {
      body: { name: '   ' },
    })
    expect(blank.status).toBe(422)
  })

  it('rejects a cent total outside JavaScript safe integer precision', async () => {
    const { homeId } = await createHome(['Asha'])
    const bill = await call('POST', `/api/homes/${homeId}/bills`, {
      body: { title: 'Rent', totalCents: Number.MAX_SAFE_INTEGER + 1 },
    })
    expect(bill.status).toBe(422)
  })

  it('cannot pay a share through a different bill URL', async () => {
    const { homeId } = await createHome(['Asha'])
    const firstBill = await createBill(homeId, 100)
    const secondBill = await createBill(homeId, 200)
    const share = firstBill.body.shares[0]
    if (!share) throw new Error('first bill has no shares')

    const response = await call('POST', `/api/bills/${secondBill.body.id}/shares/${share.id}/pay`, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    })
    expect(response.status).toBe(404)
  })

  it('allows only one competing payment with different keys', async () => {
    const { homeId } = await createHome(['Asha'])
    const bill = await createBill(homeId, 500)
    const share = bill.body.shares[0]
    if (!share) throw new Error('bill has no shares')
    const path = `/api/bills/${bill.body.id}/shares/${share.id}/pay`

    const responses = await Promise.all([
      call<Share>('POST', path, { headers: { 'Idempotency-Key': 'attempt-a' } }),
      call<Share>('POST', path, { headers: { 'Idempotency-Key': 'attempt-b' } }),
    ])

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
  })

  it('returns one stored result for simultaneous retries with the same key', async () => {
    const { homeId } = await createHome(['Asha'])
    const bill = await createBill(homeId, 500)
    const share = bill.body.shares[0]
    if (!share) throw new Error('bill has no shares')
    const path = `/api/bills/${bill.body.id}/shares/${share.id}/pay`
    const key = crypto.randomUUID()

    const responses = await Promise.all([
      call<Share>('POST', path, { headers: { 'Idempotency-Key': key } }),
      call<Share>('POST', path, { headers: { 'Idempotency-Key': key } }),
    ])

    expect(responses.every((response) => response.status === 200)).toBe(true)
    expect(responses[0]?.body.paidAt).toBe(responses[1]?.body.paidAt)
  })
})
