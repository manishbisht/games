import { useState } from 'react'
import { ArrowDownUp, ArrowRight, Check, Handshake } from 'lucide-react'
import { BOARD, money } from '@games/shared/estate/board'
import { ownedSpaces, validTrade } from '@games/shared/estate'
import type { GameAction, GameState, Trade } from '@games/shared/estate/types'
import Dialog from './Dialog'

export default function TradeDialog({
  state,
  dispatch,
  onClose,
}: {
  state: GameState
  dispatch: React.Dispatch<GameAction>
  onClose: () => void
}) {
  const others = state.players.filter((p) => p.id !== state.current && !p.bankrupt)
  const [draft, setDraft] = useState<Trade>({
    from: state.current,
    to: others[0]?.id ?? 0,
    giveCash: 0,
    getCash: 0,
    giveProperties: [],
    getProperties: [],
  })
  const trade = state.trade || draft
  const proposer = state.players[trade.from],
    recipient = state.players[trade.to]
  function toggle(key: 'giveProperties' | 'getProperties', id: number) {
    setDraft((d) => ({ ...d, [key]: d[key].includes(id) ? d[key].filter((n) => n !== id) : [...d[key], id] }))
  }
  return (
    <Dialog
      title={state.trade ? 'A deal on the table.' : 'Let’s make a deal.'}
      eyebrow="BETTER TOGETHER. SOMETIMES."
      onClose={onClose}
      className="trade-dialog"
    >
      {state.trade ? (
        <>
          <div className="trade-recipient">
            <Handshake size={34} />
            <p>
              <strong>{recipient.name}</strong>, {proposer.name} has made you an offer.
            </p>
            <small>
              {recipient.isBot
                ? 'Your computer opponent is considering the offer…'
                : `Pass the device to ${recipient.name} to review and confirm.`}
            </small>
          </div>
          <div className="trade-columns">
            {(['give', 'get'] as const).map((side) => (
              <div className="trade-review" key={side}>
                <span className="eyebrow">
                  {side === 'give' ? `${proposer.name} OFFERS` : `${proposer.name} RECEIVES`}
                </span>
                <strong>{money(side === 'give' ? trade.giveCash : trade.getCash)}</strong>
                {(side === 'give' ? trade.giveProperties : trade.getProperties).map((id) => (
                  <p key={id}>
                    <i style={{ background: BOARD[id].color }} />
                    {BOARD[id].name}
                    {state.properties[id].mortgaged && ' (mortgaged)'}
                  </p>
                ))}
              </div>
            ))}
          </div>
          <div className="inline-notice">
            <Check size={17} /> {proposer.name} confirmed this offer. {recipient.name}'s acceptance completes
            the trade.
          </div>
          {!recipient.isBot && (
            <div className="dialog-actions">
              <button
                className="secondary-button"
                onClick={() => {
                  dispatch({ type: 'REJECT_TRADE' })
                  onClose()
                }}
              >
                Decline
              </button>
              <button
                className="primary-button"
                onClick={() => {
                  dispatch({ type: 'ACCEPT_TRADE' })
                  onClose()
                }}
              >
                Accept as {recipient.name} <Check size={17} />
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="dialog-description">
            Swap properties, sweeten the deal with cash, and find your next opportunity. Both players must
            confirm.
          </p>
          <label className="field-label">
            TRADE WITH
            <select
              value={draft.to}
              onChange={(e) =>
                setDraft((d) => ({ ...d, to: Number(e.target.value), getProperties: [], getCash: 0 }))
              }
            >
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.isBot ? ' · Computer' : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="trade-columns">
            {(['give', 'get'] as const).map((side) => {
              const player = side === 'give' ? proposer : recipient,
                cashKey = side === 'give' ? 'giveCash' : 'getCash',
                propKey = side === 'give' ? 'giveProperties' : 'getProperties'
              const owned = ownedSpaces(state, player.id)
              return (
                <div className="trade-column" key={side}>
                  <h3>
                    {side === 'give' ? 'You offer' : 'You receive'} <ArrowDownUp size={15} />
                  </h3>
                  <label className="cash-input">
                    <span>$</span>
                    <input
                      aria-label={side === 'give' ? 'Cash you offer' : 'Cash you request'}
                      type="number"
                      min="0"
                      max={player.cash}
                      value={draft[cashKey]}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          [cashKey]: Math.max(0, Math.floor(Number(e.target.value) || 0)),
                        }))
                      }
                    />
                  </label>
                  <small className="muted">{money(player.cash)} available</small>
                  <div className="trade-property-list">
                    {owned.length ? (
                      owned.map((b) => {
                        const developed = BOARD.some(
                          (other) => other.group === b.group && (state.properties[other.id]?.level || 0) > 0,
                        )
                        return (
                          <label key={b.id} className={developed ? 'disabled' : ''}>
                            <input
                              type="checkbox"
                              disabled={developed}
                              checked={draft[propKey].includes(b.id)}
                              onChange={() => toggle(propKey, b.id)}
                            />
                            <span>
                              <strong>{b.name}</strong>
                              <small>
                                {developed
                                  ? 'Sell group buildings first'
                                  : state.properties[b.id].mortgaged
                                    ? 'Mortgaged'
                                    : b.group}
                              </small>
                            </span>
                          </label>
                        )
                      })
                    ) : (
                      <p className="muted small-copy">No properties yet. Cash offers are welcome.</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <button
            className="primary-button full-width"
            disabled={!validTrade(state, draft)}
            onClick={() => dispatch({ type: 'PROPOSE_TRADE', trade: draft })}
          >
            Confirm & send offer <ArrowRight size={17} />
          </button>
          <p className="dialog-footnote">
            Mortgages stay with traded properties. Buildings must be sold first.
          </p>
        </>
      )}
    </Dialog>
  )
}
