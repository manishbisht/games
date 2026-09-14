import { expect, test } from '@playwright/test'

/**
 * A host filling empty seats in their own room. Cheaper than the two-browser
 * online specs and covers the part they cannot: the seats nobody is behind, and
 * a table that starts anyway.
 */

/**
 * Create a Wildrise room of `seats` as `name`, and land in its waiting room.
 * The size matters: a table only offers a chair to a bot while it has one free,
 * which is the same rule that turns a latecomer away.
 */
async function openRoom(page: import('@playwright/test').Page, seats = 4, name = 'Robin') {
  await page.goto('/#/wildrise')
  await page.getByRole('button', { name: 'Play online', exact: true }).click()
  await page
    .getByRole('group', { name: 'Table size' })
    .getByRole('button', { name: String(seats), exact: true })
    .click()
  await page.getByLabel('Your name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Create room', exact: true }).click()
  await expect(page).toHaveURL(/\/wildrise\/room\/[A-Z2-9]{6}$/)
  await expect(page.getByRole('heading', { name: /^Room / })).toBeVisible()
}

test('a host seats bots on the empty chairs and the table plays itself', async ({ page }) => {
  await openRoom(page)
  await page.getByRole('button', { name: /Take seat 1/ }).click()
  await expect(page.getByRole('button', { name: /Leave seat/ })).toBeVisible()

  // Pace, not strength: the picker offers what this game actually varies.
  const picker = page.getByLabel('Bot skill for Take seat 2', { exact: true })
  await expect(picker).toBeVisible()
  await picker.selectOption('fast')

  const addButtons = page.getByRole('button', { name: 'Add bot', exact: true })
  await addButtons.first().click()
  // The seat now reads as a player at the table, with the pace it was given.
  // Scoped to buttons: the same label sits in every other seat's picker too.
  await expect(page.getByRole('button', { name: /Fast · keep it moving/ })).toBeVisible()
  await expect(page.getByText('(away)')).toHaveCount(0)

  await addButtons.first().click()
  // Two people's worth of seats filled, and the button counts them apart.
  await expect(page.getByRole('button', { name: /Start .*1 player and 2 bots/ })).toBeVisible()
  await page.screenshot({ path: 'test-results/bot-room-waiting.png', fullPage: true })

  await page.getByRole('button', { name: /^Start/ }).click()
  // The room deals and starts taking the bots' turns; the board is live.
  await expect(page.locator('.wr-canvas canvas, canvas')).toBeVisible()
  await expect(page.getByRole('heading', { name: /^Room / })).toHaveCount(0)
})

test('a bot gives its seat back when the host removes it', async ({ page }) => {
  await openRoom(page)
  await page.getByRole('button', { name: /Take seat 1/ }).click()
  await expect(page.getByRole('button', { name: /Leave seat/ })).toBeVisible()
  await page.getByRole('button', { name: 'Add bot', exact: true }).first().click()

  const remove = page.getByRole('button', { name: /^Remove / })
  await expect(remove).toBeVisible()
  const seatWas = await remove.getAttribute('aria-label')
  await remove.click()
  // The chair is open again, and free for someone who turned up late.
  await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Take seat 2/ })).toBeEnabled()
  expect(seatWas).toMatch(/^Remove \w+/)
})

test('only the host is offered the bot controls', async ({ page, browser }) => {
  await openRoom(page)
  await page.getByRole('button', { name: /Take seat 1/ }).click()
  const url = page.url()

  // A separate context is a separate person, so this one is not the host.
  const guestContext = await browser.newContext()
  const guest = await guestContext.newPage()
  await guest.goto(url)
  await guest.getByLabel('Your name', { exact: true }).fill('Sam')
  await guest.getByRole('button', { name: 'Join room', exact: true }).click()
  await expect(guest.getByRole('button', { name: /Take seat 2/ })).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Add bot', exact: true })).toHaveCount(0)
  await expect(guest.getByRole('button', { name: /^Start/ })).toHaveCount(0)
  await guestContext.close()
})

test('a table the host has filled offers no more chairs', async ({ page }) => {
  await openRoom(page, 2)
  await page.getByRole('button', { name: /Take seat 1/ }).click()
  await expect(page.getByRole('button', { name: /Leave seat/ })).toBeVisible()
  await page.getByRole('button', { name: 'Add bot', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Remove / })).toBeVisible()
  // A bot occupies its seat for every purpose, fullness included.
  await expect(page.getByRole('button', { name: 'Add bot', exact: true })).toHaveCount(0)
})

test('a chess room offers the two strengths its search can afford', async ({ page }) => {
  await page.goto('/#/chess')
  await page.getByRole('button', { name: 'Play online', exact: true }).click()
  await page.getByLabel('Your name', { exact: true }).fill('Robin')
  await page.getByRole('button', { name: 'Create room', exact: true }).click()
  await expect(page).toHaveURL(/\/chess\/room\/[A-Z2-9]{6}$/)
  await page.getByRole('button', { name: /Play as White/ }).click()
  await expect(page.getByRole('button', { name: /Leave seat/ })).toBeVisible()
  // Easy and Medium only: hard costs about 1.14s of server CPU a move.
  const picker = page.getByLabel('Bot skill for Play as Black', { exact: true })
  await expect(picker.locator('option')).toHaveCount(2)
  await page.getByRole('button', { name: 'Add bot', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Remove / })).toBeVisible()
})
