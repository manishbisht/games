import ThemeControl from '../theme/ThemeControl'
import { ArrowRight, Bot, Dices, Globe2, Heart, House, Monitor, Users } from 'lucide-react'
import { Link } from 'react-router'
import { games } from '../games/catalog'
import { HeaderAuth } from '../online/identity'
import { PlayersOnlineBadge } from '../online/playersOnline'
import './HomePage.css'
import './ChessPreview.css'
import './PrismPreview.css'
import './WildrisePreview.css'

function BoardPreview({ game }: { game: string }) {
  return (
    <div className={`collection-preview collection-preview-${game}`} aria-hidden="true">
      <span className="collection-preview-caption">THE TABLE IS SET</span>
      <div className="collection-board">
        {game === 'wildrise' ? (
          <div className="collection-wildrise-grid">
            {Array.from({ length: 100 }, (_, i) => (
              <span key={i}>
                {Math.floor(i / 10) % 2 === 0 ? 100 - i : 81 - Math.floor(i / 10) * 10 + (i % 10) + 10}
              </span>
            ))}
            <svg viewBox="0 0 100 100">
              <path d="M21 18C4 38 45 39 28 60S49 75 41 89" stroke="#668e78" />
              <path d="M81 10C95 26 62 22 70 39S86 53 66 68" stroke="#a182ad" />
              <path
                d="m15 79 38-61m-32 65 38-61M20 74l6 4m-1-12 6 4m-1-12 6 4m-1-12 6 4m-1-12 6 4m-1-12 6 4m-1-12 6 4m-1-12 6 4"
                className="collection-wildrise-ladder"
              />
              <circle cx="21" cy="18" r="3.4" fill="#668e78" />
              <circle cx="81" cy="10" r="3.4" fill="#a182ad" />
            </svg>
          </div>
        ) : game === 'prism' ? (
          <div className="collection-prism-hand">
            {['7', '⇄', '✦', '+2'].map((symbol, i) => (
              <div key={symbol} className={`collection-prism-card collection-prism-card-${i}`}>
                <small>{symbol}</small>
                <strong>{symbol}</strong>
                <span>PRISM</span>
              </div>
            ))}
          </div>
        ) : game === 'chess' ? (
          <div className="collection-chess-grid">
            {Array.from({ length: 64 }, (_, i) => (
              <span key={i} className={(i + Math.floor(i / 8)) % 2 ? 'dark' : ''}>
                {i < 8 ? '♜♞♝♛♚♝♞♜'[i] : i < 16 ? '♟' : i >= 56 ? '♖♘♗♕♔♗♘♖'[i - 56] : i >= 48 ? '♙' : ''}
              </span>
            ))}
          </div>
        ) : game === 'hearth' ? (
          <>
            {['red', 'gold', 'green', 'blue'].map((color) => (
              <div className={`collection-court collection-court-${color}`} key={color}>
                <i />
                <i />
                <i />
                <i />
              </div>
            ))}
            <House className="collection-board-home" size={27} strokeWidth={1.5} />
          </>
        ) : (
          <>
            {['top', 'right', 'bottom', 'left'].map((side) => (
              <div className={`collection-properties collection-properties-${side}`} key={side}>
                {Array.from({ length: 7 }, (_, i) => (
                  <i key={i} />
                ))}
              </div>
            ))}
            <div className="collection-estate-center">
              <House size={34} strokeWidth={1.4} />
              <span>estate.</span>
            </div>
          </>
        )}
      </div>
      <div className="collection-preview-dice">
        {game === 'prism' ? (
          <span className="collection-prism-spark">✦</span>
        ) : game === 'chess' ? (
          <span className="collection-chess-knight">♞</span>
        ) : (
          <Dices size={40} strokeWidth={1.4} />
        )}
      </div>
      <span className="collection-preview-note">A fresh take on a timeless game</span>
    </div>
  )
}

export default function HomePage() {
  return (
    <div className="collection-page">
      <header className="collection-header">
        <Link to="/" className="collection-brand" aria-label="Games home">
          <span className="collection-brand-icon">
            <Dices size={25} strokeWidth={1.6} />
          </span>
          games<span className="collection-brand-period">.</span>
        </Link>
        <span className="collection-header-note">A LITTLE PLAY GOES A LONG WAY.</span>
        <span className="collection-free">
          <i /> Free to play. Always.
        </span>
        <PlayersOnlineBadge className="collection-online" />
        <ThemeControl />
        <HeaderAuth />
      </header>

      <main className="collection-main">
        <section className="collection-intro" aria-labelledby="collection-title">
          <p className="collection-eyebrow">
            <span /> GOOD COMPANY. GREAT GAMES.
          </p>
          <h1 id="collection-title">
            Make room for <em>a little play.</em>
          </h1>
          <p className="collection-intro-copy">
            A collection of familiar favorites, made for your browser.
            <br className="collection-desktop-break" /> Pull up a chair, bring a friend, and let the good
            times roll.
          </p>
          <div className="collection-benefits">
            <span>
              <Monitor size={16} /> No downloads
            </span>
            <span>
              <Users size={16} /> Play together
            </span>
            <span>
              <Bot size={16} /> Or challenge the computer
            </span>
            <span>
              <Globe2 size={16} /> All games play online
            </span>
          </div>
        </section>

        <section aria-labelledby="collection-games-title">
          <div className="collection-section-heading">
            <h2 id="collection-games-title">Pick your next game.</h2>
            <span>{games.length} games · endless good times</span>
          </div>
          <div className="collection-grid">
            {games.map((game) => (
              <article className={`collection-card collection-card-${game.id}`} key={game.id}>
                <BoardPreview game={game.id} />
                <div className="collection-card-content">
                  <p className="collection-card-eyebrow">{game.category}</p>
                  <div className="collection-card-title">
                    <h3>{game.name}</h3>
                    <img src={`${import.meta.env.BASE_URL}${game.icon}`} alt="" width="36" height="36" />
                  </div>
                  <p className="collection-description">{game.description}</p>
                  <ul className="collection-tags" aria-label={`${game.name} features`}>
                    {game.tags.map((tag) => (
                      <li key={tag}>{tag}</li>
                    ))}
                  </ul>
                  <div className="collection-card-footer">
                    <div className="collection-player-info">
                      <Users size={17} />
                      <span>
                        {game.id === 'chess' ? '2 players' : '2–4 players'}
                        <small>
                          {game.id === 'chess'
                            ? 'Online with friends'
                            : game.online
                              ? 'Bots or online friends'
                              : 'Play against bots'}
                        </small>
                      </span>
                      <PlayersOnlineBadge game={game.id} className="collection-card-online" />
                    </div>
                    <Link to={game.path} className="collection-play" aria-label={`Play ${game.name}`}>
                      Let’s play <ArrowRight size={17} />
                    </Link>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        <aside className="collection-note">
          <Heart size={17} strokeWidth={1.6} />
          <p>
            Your favorite games. Shared moments.{' '}
            <span>No accounts required, no downloads — just one more round.</span>
          </p>
        </aside>
      </main>
      <footer className="collection-footer">
        <span>Less scrolling. More rolling.</span>
        <span>
          MADE FOR GOOD COMPANY <span aria-hidden="true">✦</span>
        </span>
      </footer>
    </div>
  )
}
