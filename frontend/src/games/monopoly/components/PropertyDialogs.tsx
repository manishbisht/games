import { useState } from 'react'
import {
  ArrowDownUp,
  ArrowRight,
  Building2,
  Check,
  Home,
  Landmark,
  LockKeyhole,
  MapPin,
  TrainFront,
  Zap,
} from 'lucide-react'
import { BOARD, money } from '@games/shared/estate/board'
import {
  canBuild,
  canMortgage,
  canSellBuilding,
  hasGroup,
  ownedSpaces,
  rentFor,
  rentMultiplier,
} from '@games/shared/estate'
import type { BoardSpace, GameAction, GameState } from '@games/shared/estate/types'
import Dialog from './Dialog'

export function SpaceIcon({ space, size = 20 }: { space: BoardSpace; size?: number }) {
  if (space.kind === 'railroad') return <TrainFront size={size} />
  if (space.kind === 'utility') return <Zap size={size} />
  if (space.kind === 'property') return <Building2 size={size} />
  return <MapPin size={size} />
}
export function PropertyDetail({
  id,
  state,
  dispatch,
  onClose,
}: {
  id: number
  state: GameState
  dispatch: React.Dispatch<GameAction>
  onClose: () => void
}) {
  const b = BOARD[id],
    prop = state.properties[id],
    player = state.players[state.current]
  const yours = prop?.owner === player.id,
    manageable = yours && !player.isBot && ['ready', 'end', 'debt'].includes(state.phase) && !state.trade
  const purchasable = state.phase === 'purchase' && player.position === id && !player.isBot
  return (
    <Dialog
      title={b.name}
      eyebrow={b.group || b.kind.toUpperCase()}
      onClose={onClose}
      className="property-dialog"
    >
      <div
        className="property-banner"
        style={{ '--property-color': b.color || '#91a89b' } as React.CSSProperties}
      >
        <SpaceIcon space={b} size={40} />
        <span>{b.price ? money(b.price) : 'A little twist in the journey.'}</span>
      </div>
      {b.price ? (
        <>
          <div className="ownership-line">
            <span>{prop ? 'Owned by' : 'Available from the bank'}</span>
            {prop ? (
              <strong style={{ color: state.players[prop.owner].color }}>
                {state.players[prop.owner].name} {yours && '(you)'}
              </strong>
            ) : (
              <span className="small-pill">FOR SALE</span>
            )}
          </div>
          {prop?.mortgaged && (
            <div className="inline-notice">
              <LockKeyhole size={16} /> Mortgaged · No rent is collected
            </div>
          )}
          <div className="rent-table">
            {b.rents ? (
              b.rents.map((rent, i) => (
                <div className={prop?.level === i ? 'highlighted' : ''} key={i}>
                  <span>
                    {i === 0
                      ? 'Base rent'
                      : i === 5
                        ? 'With a hotel'
                        : `With ${i} ${i === 1 ? 'house' : 'houses'}`}
                  </span>
                  <strong>{money(rent)}</strong>
                </div>
              ))
            ) : b.kind === 'railroad' ? (
              [25, 50, 100, 200].map((rent, i) => (
                <div key={rent}>
                  <span>
                    {i + 1} {i ? 'stations' : 'station'} owned
                  </span>
                  <strong>{money(rent)}</strong>
                </div>
              ))
            ) : (
              <>
                <div>
                  <span>One utility owned</span>
                  <strong>4 × dice roll</strong>
                </div>
                <div>
                  <span>Both utilities owned</span>
                  <strong>10 × dice roll</strong>
                </div>
              </>
            )}
          </div>
          {prop && (
            <div className="rent-current">
              <span>
                Current rent{rentMultiplier(state) > 1 ? ` · quick mode ×${rentMultiplier(state)}` : ''}
              </span>
              <strong>
                {money(rentFor(state, id))}
                {b.kind === 'utility' && <small> on this roll</small>}
              </strong>
            </div>
          )}
          {b.kind === 'property' && (
            <p className="muted small-copy">
              Own the full color group to double base rent and build evenly. A house or hotel upgrade costs{' '}
              {money(b.buildCost || 0)}.
            </p>
          )}
          {purchasable && (
            <div className="dialog-actions">
              <button
                className="secondary-button"
                onClick={() => {
                  dispatch({ type: 'PASS' })
                  onClose()
                }}
              >
                Pass
              </button>
              <button
                className="primary-button"
                disabled={player.cash < b.price}
                onClick={() => {
                  dispatch({ type: 'BUY' })
                  onClose()
                }}
              >
                Buy for {money(b.price)} <ArrowRight size={17} />
              </button>
            </div>
          )}
          {manageable && (
            <div className="property-management">
              {b.kind === 'property' && (
                <>
                  <button
                    className="primary-button full-width"
                    disabled={!canBuild(state, id)}
                    onClick={() => dispatch({ type: 'BUILD', property: id })}
                  >
                    <Home size={17} />{' '}
                    {prop.level === 4
                      ? 'Build hotel'
                      : prop.level === 5
                        ? 'Fully developed'
                        : 'Build a house'}{' '}
                    · {money(b.buildCost || 0)}
                  </button>
                  {!hasGroup(state, id, player.id) && (
                    <p className="small-copy muted">Complete this color group to start building.</p>
                  )}
                  {prop.level > 0 && (
                    <button
                      className="secondary-button full-width"
                      disabled={!canSellBuilding(state, id)}
                      onClick={() => dispatch({ type: 'SELL_BUILDING', property: id })}
                    >
                      Sell a building · +{money((b.buildCost || 0) / 2)}
                    </button>
                  )}
                </>
              )}
              <button
                className="secondary-button full-width"
                disabled={
                  prop.mortgaged
                    ? Boolean(state.debt) || player.cash < Math.ceil(b.price * 0.55)
                    : !canMortgage(state, id)
                }
                onClick={() => dispatch({ type: prop.mortgaged ? 'UNMORTGAGE' : 'MORTGAGE', property: id })}
              >
                <Landmark size={17} />
                {prop.mortgaged
                  ? `Unmortgage · ${money(Math.ceil(b.price * 0.55))}`
                  : `Mortgage · +${money(b.price / 2)}`}
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="special-space-description">
          {b.kind === 'go'
            ? 'Collect $200 every time you pass or land on GO. Every lap is a fresh opportunity.'
            : b.kind === 'jail'
              ? 'Just visiting? Relax. In jail? Pay $50 before rolling, or try for doubles. After three failed attempts, the $50 release fee is required.'
              : b.kind === 'go-to-jail'
                ? 'Go directly to jail, without collecting $200. Your turn ends here.'
                : b.kind === 'parking'
                  ? 'Enjoy a well-earned break. No fees, no rewards—just a moment to plan your next move.'
                  : b.kind === 'tax'
                    ? `Pay ${money(b.amount || 0)} to the bank. If cash is tight, mortgage properties or sell buildings to cover the payment.`
                    : 'Draw a card and see what the city has in store. You may collect money, pay a fee, or find yourself on the move.'}
        </p>
      )}
    </Dialog>
  )
}
export function PortfolioDialog({
  state,
  onClose,
  onSelect,
  initialPlayer,
}: {
  state: GameState
  onClose: () => void
  onSelect: (id: number) => void
  initialPlayer?: number
}) {
  const [tab, setTab] = useState<number | 'all'>(initialPlayer ?? state.current)
  const spaces = tab === 'all' ? BOARD.filter((b) => b.price) : ownedSpaces(state, tab)
  return (
    <Dialog
      title="The property portfolio."
      eyebrow="EVERY EMPIRE STARTS SOMEWHERE"
      onClose={onClose}
      className="portfolio-dialog"
    >
      <div className="portfolio-tabs">
        {state.players.map((p) => (
          <button key={p.id} className={tab === p.id ? 'active' : ''} onClick={() => setTab(p.id)}>
            <i style={{ background: p.color }} />
            {p.name}
          </button>
        ))}
        <button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>
          All properties
        </button>
      </div>
      {spaces.length ? (
        <div className="portfolio-list">
          {spaces.map((b) => {
            const prop = state.properties[b.id]
            return (
              <button key={b.id} className="portfolio-property" onClick={() => onSelect(b.id)}>
                <span className="property-color" style={{ background: b.color }} />
                <div>
                  <strong>{b.name}</strong>
                  <small>
                    {b.group}{' '}
                    {prop?.mortgaged
                      ? '· Mortgaged'
                      : prop?.level
                        ? `· ${prop.level === 5 ? 'Hotel' : `${prop.level} houses`}`
                        : ''}
                  </small>
                </div>
                <span>
                  {prop ? (
                    <span style={{ color: state.players[prop.owner].color }}>
                      {state.players[prop.owner].name}
                    </span>
                  ) : (
                    money(b.price || 0)
                  )}
                </span>
                <ArrowRight size={16} />
              </button>
            )
          })}
        </div>
      ) : (
        <div className="empty-portfolio">
          <Building2 size={34} />
          <h3>Your story is still unwritten.</h3>
          <p>Land on an available property and make your first investment.</p>
          <button className="secondary-button" onClick={() => setTab('all')}>
            Explore the properties <ArrowRight size={16} />
          </button>
        </div>
      )}
      <div className="portfolio-key">
        <Check size={15} /> Select a property to see rent, build, or mortgage.
      </div>
    </Dialog>
  )
}
export function PropertySummary({ state, onClick }: { state: GameState; onClick: () => void }) {
  const count = ownedSpaces(state, state.current).length
  return (
    <button className="utility-action" onClick={onClick}>
      <Building2 size={17} />
      <span>My properties</span>
      <span className="count-badge">{count}</span>
    </button>
  )
}
export function TradeButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button className="utility-action" disabled={disabled} onClick={onClick}>
      <ArrowDownUp size={17} />
      <span>Make a trade</span>
    </button>
  )
}
