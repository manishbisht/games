import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const guide = (page: Page) => page.locator('.pr-guide-card')

/** The step on show, by its title, with its ring drawn round something on screen. */
async function onStep(page: Page, title: string, shot: string) {
  // A dialog in name only: the table around it stays live.
  await expect(page.getByRole('dialog', { name: title })).toHaveAttribute('aria-modal', 'false')
  await expect(page.locator('.pr-guide-ring')).toBeVisible()
  await page.screenshot({ path: `test-results/prism-guide-${shot}.png` })
}

for (const [label, viewport] of [
  ['desktop', { width: 1440, height: 960 }],
  ['phone', { width: 390, height: 844 }],
] as const) {
  test(`the first table walks a new player through it, once (${label})`, async ({ page }) => {
    test.setTimeout(120000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/#/prism')
    await page.getByRole('button', { name: 'Mute sound', exact: true }).click()
    await page.getByRole('button', { name: '2 players', exact: true }).click()
    await page.getByRole('button', { name: 'Let’s play', exact: true }).click()
    await expect(page.locator('.pr-card')).toHaveCount(7, { timeout: 20000 })

    // It waits for the deal, then takes focus to offer the next step.
    await onStep(page, 'Match the pile', `${label}-1`)
    await expect(guide(page).getByRole('button', { name: 'Next' })).toBeFocused()
    await page.keyboard.press('Enter')

    // Playing a card is what moves this one on; without one to play, Next does.
    await onStep(page, 'Play from your hand', `${label}-2`)
    const legal = page.locator('.pr-card.pr-playable')
    if (await legal.count()) {
      await legal.first().click()
      await legal.first().click()
      if (await page.getByRole('dialog', { name: 'Choose a color' }).count())
        await page.getByRole('button', { name: 'Choose blue', exact: true }).click()
    } else await guide(page).getByRole('button', { name: 'Next' }).click()

    // Drawing moves this one on, when it is still this seat's turn to draw.
    await onStep(page, 'Draw when you can’t', `${label}-3`)
    const draw = page.getByRole('button', { name: 'Draw card', exact: true })
    if (await draw.isEnabled()) await draw.click()
    else await guide(page).getByRole('button', { name: 'Next' }).click()

    await onStep(page, 'Action cards', `${label}-4`)
    await guide(page).getByRole('button', { name: 'Next' }).click()
    await onStep(page, 'Call “Prism!”', `${label}-5`)
    await guide(page).getByRole('button', { name: 'Got it' }).click()
    await expect(guide(page)).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem('games-guide-prism'))).toBe('done')

    // Back by request from the rules, and gone again on Escape.
    await page.getByRole('button', { name: 'How to play', exact: true }).click()
    await page.getByRole('button', { name: 'Show the guide again' }).click()
    await expect(page.locator('#pr-guide-title')).toHaveText('Match the pile')
    await page.keyboard.press('Escape')
    await expect(guide(page)).toHaveCount(0)

    // Once is enough: the table comes back without it.
    await page.reload()
    await expect(page.locator('.pr-card').first()).toBeVisible({ timeout: 20000 })
    await expect(page.locator('.pr-arena[aria-busy="true"]')).toHaveCount(0, { timeout: 15000 })
    await expect(guide(page)).toHaveCount(0)
    expect(errors).toEqual([])
  })
}
