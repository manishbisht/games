import { useEffect, useLayoutEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { ArrowLeft, Check, Dices, Link2 } from 'lucide-react'
import { Link, useParams } from 'react-router'
import type {
  GameId,
  GameStats,
  MyProfile,
  PublicGameRecord,
  PublicProfile,
  Rating,
} from '@games/shared/protocol'
import { games } from '../games/catalog'
import { useCountUp } from '../motion/hooks'
import { fetchPlayer } from '../online/api'
import { HeaderAuth, useIdentity } from '../online/identity'
import NotifyToggle from '../online/NotifyToggle'
import { useMe } from '../online/useMe'
import ThemeControl from '../theme/ThemeControl'
import { dayAgo, ordinal, timeAgo, toTime } from './format'
import YourTables from './YourTables'
import './ProfilePage.css'

const gameOf = (id: GameId) => games.find((game) => game.id === id)

/** Who a profile belongs to, as the page shows it while there is no name yet. */
const initial = (name: string) => (name.trim()[0] ?? '?').toUpperCase()

function Header() {
  return (
    <header className="profile-header">
      <Link to="/" className="profile-brand" aria-label="Games home">
        <span className="profile-brand-icon">
          <Dices size={22} strokeWidth={1.6} />
        </span>
        games<span className="profile-brand-period">.</span>
      </Link>
      <div className="profile-header-controls">
        <ThemeControl />
        <HeaderAuth />
      </div>
    </header>
  )
}

function RatingCard({ rating }: { rating: Rating }) {
  const shown = useCountUp(rating.rating, 900, { from: 1200 })
  return (
    <article className="profile-card profile-rating" style={{ '--i': 0 } as CSSProperties}>
      <p className="profile-card-eyebrow">Gambit rating</p>
      <p className="profile-rating-number" aria-label={`Rating ${rating.rating}`}>
        {shown}
      </p>
      <p className="profile-rating-meta">
        {rating.provisional ? (
          <span className="profile-pill" title="Settles after ten rated games">
            Provisional · {rating.games} of 10
          </span>
        ) : (
          <span>
            {rating.games} rated {rating.games === 1 ? 'game' : 'games'}
          </span>
        )}
        <span>Peak {rating.peak}</span>
      </p>
    </article>
  )
}

function StatsCard({ game, stats, index }: { game: GameId; stats: GameStats; index: number }) {
  const entry = gameOf(game)
  if (!entry) return null
  const share = (n: number) => `${(n / Math.max(1, stats.played)) * 100}%`
  return (
    <article className="profile-card profile-stats" style={{ '--i': index } as CSSProperties}>
      <div className="profile-stats-title">
        <img src={`${import.meta.env.BASE_URL}${entry.icon}`} alt="" width="34" height="34" />
        <div>
          <h3>{entry.name}</h3>
          <p>
            {stats.played} {stats.played === 1 ? 'game' : 'games'} ·{' '}
            {Math.round((stats.wins / Math.max(1, stats.played)) * 100)}% won
          </p>
        </div>
      </div>
      <div className="profile-stats-bar" aria-hidden="true">
        <i className="profile-bar-win" style={{ width: share(stats.wins) }} />
        <i className="profile-bar-draw" style={{ width: share(stats.draws) }} />
        <i className="profile-bar-loss" style={{ width: share(stats.losses) }} />
      </div>
      <p className="profile-stats-counts">
        <span>
          <i className="profile-dot-win" /> {stats.wins} won
        </span>
        <span>
          <i className="profile-dot-loss" /> {stats.losses} lost
        </span>
        {stats.draws > 0 && (
          <span>
            <i className="profile-dot-draw" /> {stats.draws} drawn
          </span>
        )}
      </p>
    </article>
  )
}

function resultLabel(record: PublicGameRecord) {
  if (record.place && record.seats > 2) return `${ordinal(record.place)} of ${record.seats}`
  return record.result === 'win' ? 'Won' : record.result === 'loss' ? 'Lost' : 'Draw'
}

/**
 * When each game was. A player's own record says it to the minute; a public
 * profile is only told the day (and may be told it as a date string), so it
 * says the day — never "14 hr. ago" for a game that was this morning.
 */
function When({ at, now, byDay }: { at: number | string; now: number; byDay: boolean }) {
  const time = toTime(at)
  if (!Number.isFinite(time)) return null
  const iso = new Date(time).toISOString()
  return (
    <time dateTime={byDay ? iso.slice(0, 10) : iso}>{byDay ? dayAgo(time, now) : timeAgo(time, now)}</time>
  )
}

function History({ records, now, byDay }: { records: PublicGameRecord[]; now: number; byDay: boolean }) {
  return (
    <ol className="profile-history">
      {records.map((record, index) => {
        const entry = gameOf(record.game)
        const delta = record.rating ? record.rating.after - record.rating.before : null
        return (
          <li key={`${record.at}-${index}`} style={{ '--i': index } as CSSProperties}>
            <span className={`profile-result profile-result-${record.result}`}>{resultLabel(record)}</span>
            <div className="profile-history-body">
              <strong>{entry?.name ?? record.game}</strong>
              <span>
                {record.opponents.length ? 'vs ' : 'Solo'}
                {record.opponents.map((opponent, i) => (
                  <span key={i}>
                    {i > 0 && (i === record.opponents.length - 1 ? ' and ' : ', ')}
                    {opponent.handle ? (
                      <Link to={`/player/${opponent.handle}`}>{opponent.name}</Link>
                    ) : (
                      <>
                        {opponent.name}
                        {opponent.bot && <small> (bot)</small>}
                      </>
                    )}
                  </span>
                ))}
              </span>
            </div>
            <div className="profile-history-side">
              {delta !== null && (
                <span className={`profile-delta${delta >= 0 ? ' profile-delta-up' : ''}`}>
                  {delta >= 0 ? `+${delta}` : `−${-delta}`}
                </span>
              )}
              <When at={record.at} now={now} byDay={byDay} />
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function ShareLink({ handle }: { handle: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  const url = `${location.origin}${location.pathname}#/player/${handle}`
  return (
    <button
      type="button"
      className="profile-share"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url)
          setCopied(true)
        } catch {
          window.prompt('Copy your profile link', url)
        }
      }}
    >
      {copied ? <Check size={15} /> : <Link2 size={15} />}
      {copied ? 'Link copied' : 'Share profile'}
    </button>
  )
}

/**
 * A player's games: their rating at Gambit, how each game has gone, and their
 * recent results. `/me` is the owner's own copy, with the tables they are still
 * at and the switch for turn notifications; `/player/:handle` is what anyone
 * with the link sees — the same record without room codes or tables.
 */
function Profile({ profile, mine }: { profile: PublicProfile | MyProfile; mine: boolean }) {
  const identity = useIdentity()
  const [now] = useState(() => Date.now())
  const name = mine ? identity.name || profile.name || 'You' : profile.name || 'A player'
  const avatar = mine ? (identity.avatar ?? profile.avatar) : profile.avatar
  const played = Object.values(profile.stats).reduce((sum, stats) => sum + (stats?.played ?? 0), 0)
  const statGames = (Object.keys(profile.stats) as GameId[]).sort(
    (a, b) => (profile.stats[b]?.played ?? 0) - (profile.stats[a]?.played ?? 0),
  )
  const active = 'active' in profile ? profile.active : []
  const signedIn = mine ? identity.isSignedIn : !profile.isGuest
  const since = toTime(profile.since) || 0
  return (
    <>
      <section className="profile-hero">
        <span className="profile-avatar" aria-hidden="true">
          {avatar ? <img src={avatar} alt="" width="72" height="72" /> : initial(name)}
        </span>
        <div className="profile-hero-text">
          <p className="profile-eyebrow">{mine ? 'YOUR GAMES' : 'PLAYER'}</p>
          <h1>{name}</h1>
          <p className="profile-hero-meta">
            {signedIn ? 'Signed in' : 'Guest player'}
            {played > 0 && (
              <>
                {' · '}
                {played} {played === 1 ? 'game' : 'games'} played
              </>
            )}
            {since > 0 && (
              <>
                {' '}
                · since{' '}
                {new Date(since).toLocaleDateString('en', {
                  month: 'long',
                  year: 'numeric',
                  ...(mine ? {} : { timeZone: 'UTC' }),
                })}
              </>
            )}
          </p>
        </div>
        {mine && played > 0 && <ShareLink handle={profile.handle} />}
      </section>

      {mine && <YourTables tables={active} heading="Still at the table" />}

      {played > 0 ? (
        <>
          <section className="profile-section" aria-labelledby="profile-stats-title">
            <h2 id="profile-stats-title">How it’s going</h2>
            <div className="profile-grid">
              {profile.ratings.chess && <RatingCard rating={profile.ratings.chess} />}
              {statGames.map((game, index) => (
                <StatsCard key={game} game={game} stats={profile.stats[game]!} index={index + 1} />
              ))}
            </div>
          </section>
          <section className="profile-section" aria-labelledby="profile-history-title">
            <h2 id="profile-history-title">Recent games</h2>
            <History records={profile.recent} now={now} byDay={!mine} />
          </section>
        </>
      ) : (
        <section className="profile-empty">
          <h2>{mine ? 'Your record starts with your first online game.' : 'No finished games yet.'}</h2>
          {mine && (
            <p>
              Finish a game in any online room — against friends or bots — and your results, stats and Gambit
              rating show up here.
            </p>
          )}
          <Link to="/" className="profile-cta">
            Find a game
          </Link>
        </section>
      )}

      {mine && (
        <section className="profile-section profile-notify" aria-labelledby="profile-notify-title">
          <h2 id="profile-notify-title">Notifications</h2>
          <NotifyToggle />
        </section>
      )}
    </>
  )
}

function Mine() {
  const { profile, failed } = useMe()
  if (profile) return <Profile profile={profile} mine />
  if (failed)
    return <p className="profile-status">We couldn’t load your games just now. Try again in a moment.</p>
  return <ProfileSkeleton />
}

function Theirs({ handle }: { handle: string }) {
  const [state, setState] = useState<{
    handle: string
    profile: PublicProfile | null
    failed?: boolean
  } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    fetchPlayer(handle, controller.signal).then(
      (profile) => setState({ handle, profile }),
      () => !controller.signal.aborted && setState({ handle, profile: null, failed: true }),
    )
    return () => controller.abort()
  }, [handle])
  if (!state || state.handle !== handle) return <ProfileSkeleton />
  if (state.profile) return <Profile profile={state.profile} mine={false} />
  return (
    <section className="profile-empty">
      <h2>{state.failed ? 'We couldn’t load this player just now.' : 'We couldn’t find that player.'}</h2>
      <Link to="/" className="profile-cta">
        All games
      </Link>
    </section>
  )
}

function ProfileSkeleton() {
  return (
    <div className="profile-skeleton" role="status" aria-label="Loading games">
      <i />
      <i />
      <i />
    </div>
  )
}

export default function ProfilePage() {
  const { handle } = useParams()
  // A page of its own: it opens at the top, not wherever the collection was left.
  useLayoutEffect(() => {
    window.scrollTo(0, 0)
  }, [handle])
  return (
    <div className="profile-page">
      <Header />
      <main className="profile-main">
        <Link to="/" className="profile-back">
          <ArrowLeft size={15} /> All games
        </Link>
        {handle ? <Theirs handle={handle} /> : <Mine />}
      </main>
    </div>
  )
}
