import { useMemo } from 'react'
import { Link } from 'react-router'
import { Infinity as Forever } from 'lucide-react'
import { ReplayPlayer } from '../../../online/ReplayPage'
import ChessShell from '../ChessShell'
import { readPermalink } from '../game/permalink'
import ChessReplayView from './ChessReplayView'
import '../../../online/replay.css'
import './ChessReplay.css'

/**
 * A game played back from its permanent link (`./game/permalink`): the moves
 * ride in the address, so this needs no room and never expires. Same board,
 * same player bar and keys as a room's replay page — kept to what a link with
 * no room behind it can offer — through the room replay's own ReplayPlayer.
 */
export default function ChessPermalinkReplay({ search }: { search: URLSearchParams }) {
  const replay = useMemo(() => readPermalink(search), [search])
  if (!replay)
    return (
      <ChessShell>
        <main className="ch-permalink-notice">
          <h1>That link looks wrong.</h1>
          <p>It doesn’t describe a game of chess that could have been played.</p>
          <Link to="/chess">Back to Gambit</Link>
        </main>
      </ChessShell>
    )
  return (
    <ChessShell>
      <ReplayPlayer
        key={search.toString()}
        states={replay.states}
        players={replay.players}
        View={ChessReplayView}
        game={GAMBIT}
        eyebrow="Replay · Permanent link"
        footnote={
          <>
            <Forever size={13} aria-hidden="true" />
            <span>This link carries the moves themselves, so it never expires.</span>
          </>
        }
      />
    </ChessShell>
  )
}

const GAMBIT = {
  name: 'Gambit',
  basePath: '/chess',
  replayTurn: (state: unknown) => (state as { turn: string }).turn,
}
