// @flow

import { find } from 'lodash';
import {
  WELL_ROWS,
  WELL_COLS,
  DROP_FRAMES_DEFAULT,
  DROP_FRAMES_DECREMENT,
  LINE_CLEAR_BONUSES
} from '../constants/grid';
import { SHAPES, COLORS } from '../constants/tetromino';
import {
  getNextTetromino,
  getInitialPositionForTetromino
} from '../utils/tetromino';
import {
  generateEmptyGrid,
  rotate,
  isPositionAvailable,
  getBottomMostPosition,
  transferTetrominoToGrid,
  hasLines,
  clearLines,
  fitTetrominoPositionInWellBounds,
  getBlocksFromGridRows,
  overrideBlockIds,
  appendBlocksToGrid,
  getNextCellId
} from '../utils/grid';

import type {
  UserId,
  User,
  WellGrid,
  Player,
  GameId,
  Game,
  FlashSuffix,
  QuakeSuffix
} from '../types/state';
import type { ActionId, GameAction } from '../types/actions';

export function gameReducer(state: void | Game, action: GameAction): Game {
  if (!state) {
    throw new Error(`Game action ${action.type} called on void state`);
  }

  if (action.type === 'JOIN_GAME') {
    const { actionId, userId, user } = action.payload;
    const { players } = state;

    if (players.length > 1) {
      if (isPlayer(state, user)) {
        console.warn(`User ${user.id} tried to join game more than once`);
      } else {
        console.warn(`User ${user.id} tried to join already full game`);
      }

      return state;
    }

    const [player1] = players;
    const game = updatePlayer(state, player1.user.id, {
      // Stop player1's game when player2 arrives
      status: 'PENDING',
      // Previous losses are irrelevant to 1vs1 game
      losses: 0
    });

    return bumpActionId(addUserToGame(game, user), userId, actionId);
  }

  // Ensure action consistency
  const { actionId, userId } = action.payload;
  const offset = getGameActionOffset(state, action);

  if (offset > 0) {
    throw new Error(`Refusing detached game action`);
  }
  if (offset < 0) {
    console.warn(`Past game action ${actionId} ignored (${offset}ms delta)`);

    return state;
  }

  const newState = gameJoinedReducer(state, action);

  // Don't bump player.lastActionId if action left state intact. This allows us
  // to avoid broacasting "noop" actions and minimize network activity
  // FIXME: Sometimes actions were recorded that seemed like "noop" actions when
  // played back from backfill response. Eg. Often an `ENABLE_ACCELERATION`
  // action would be recorded and then when played back it followed a state
  // that had `player.dropAcceleration: true`, which made it noop and entered
  // an infinite loop of crashed backfills. Disabling this optimization until
  // I understand what is going on.
  return newState === state
    ? newState
    : bumpActionId(newState, userId, actionId);
}

export function gameJoinedReducer(state: Game, action: GameAction): Game {
  const { userId } = action.payload;

  switch (action.type) {
    case 'PLAYER_READY': {
      const { status: prevStatus } = getPlayer(state, userId);
      const game = updatePlayer(state, userId, { status: 'READY' });

      // Reset game when all players are ready to (re)start
      if (
        allPlayersReady(game) &&
        // This condition allows solo players to pause and resume
        // (by clicking on the "2p insert coin" button)
        (game.players.length > 1 || prevStatus !== 'PAUSE')
      ) {
        const { id, players } = game;
        const round = getGameRound(game);

        return {
          ...game,
          players: players.map(player => ({
            ...player,
            ...getBlankPlayerRound({ gameId: id, round })
          })),
          dropFrames: DROP_FRAMES_DEFAULT
        };
      }

      return game;
    }

    case 'PLAYER_PAUSE': {
      if (state.players.length > 1) {
        throw new Error('Pausing multiplayer game not allowed');
      }

      return updatePlayer(state, userId, { status: 'PAUSE' });
    }

    case 'DROP': {
      const { rows } = action.payload;
      const player = getPlayer(state, userId);
      const {
        grid,
        activeTetromino,
        activeTetrominoGrid,
        activeTetrominoPosition,
        dropAcceleration,
        flashYay,
        quake
      } = player;

      // Clear lines generated by a previous `APPEND_PENDING_BLOCKS` action
      // NOTE: Old functionality left for posterity
      // if (hasLines(grid)) {
      //   const { clearedGrid, rowsCleared } = clearLines(grid);
      //   const blocksCleared = getBlocksFromGridRows(grid, rowsCleared);
      //   const newState = updatePlayer(state, userId, {
      //     grid: clearedGrid,
      //     blocksCleared
      //   });
      //
      //   return rewardClearedBlocks(newState, userId);
      // }

      // Drop active Tetromino until it hits something
      let newPosition = {
        x: activeTetrominoPosition.x,
        y: activeTetrominoPosition.y + rows
      };

      // New active Tetromino position is available, uneventful path
      if (isPositionAvailable(grid, activeTetrominoGrid, newPosition)) {
        return updatePlayer(state, userId, {
          activeTetrominoPosition: newPosition
        });
      }

      // Active Tetromino has hit the ground
      // A big frame skip could cause the Tetromino to jump more than one row.
      // We need to ensure it ends up in the bottom-most one in case the jump
      // caused the Tetromino to land
      newPosition = getBottomMostPosition(
        grid,
        activeTetrominoGrid,
        newPosition
      );

      // Game over when active Tetromino lands (partially) outside the well.
      // NOTE: This is not ideal because the landed Tetromino, even though it
      // doesn't fit when it lands, could cause one or more lines which
      // after cleared could make room for the entire Tetromino. To implement
      // this we would need to somehow re-apply the part of the active Tetromino
      // that didn't fit upon landing, after the lines have been cleared.
      if (newPosition.y < 0) {
        return {
          ...state,
          players: state.players.map(player => {
            const newAttrs =
              // TODO: Only set LOST state. Allow for draw
              player.user.id === userId
                ? { status: 'LOST', losses: player.losses + 1 }
                : { status: 'WON' };

            return {
              ...player,
              ...newAttrs
            };
          })
        };
      }

      // This is when the active Tetromino hits the bottom of the Well and can
      // no longer be controlled
      const newGrid = transferTetrominoToGrid(
        player,
        activeTetrominoGrid,
        newPosition,
        COLORS[activeTetromino]
      );
      let newState = state;

      const round = getGameRound(newState);
      const drops = player.drops + 1;

      newState = updatePlayer(newState, userId, {
        drops: drops,
        grid: newGrid,
        ...getNextPlayerTetromino({ gameId: state.id, round, drops }),
        // Clear acceleration after dropping Tetromino. Sometimes the key
        // events would misbehave and acceleration would remain on even after
        // releasing DOWN key
        dropAcceleration: false
      });

      if (!hasLines(newGrid)) {
        return newState;
      }

      const { clearedGrid, rowsCleared } = clearLines(newGrid);
      const blocksCleared = getBlocksFromGridRows(newGrid, rowsCleared);
      newState = updatePlayer(newState, userId, {
        grid: clearedGrid,
        blocksCleared,
        flashYay: altFlashClass(flashYay),
        quake: dropAcceleration
          ? altQuakeClass(quake, rowsCleared.length)
          : null
      });
      newState = rewardClearedBlocks(newState, userId);

      // Transfer blocks from cleared lines to enemy grid 😈
      // We reference the old grid, to get the blocks of the cleared lines
      // *without* the blocks added from the just transfered active Tetromino
      return sendClearedBlocksToEnemy(newState, userId, grid, rowsCleared);
    }

    case 'APPEND_PENDING_BLOCKS': {
      const player = getPlayer(state, userId);
      const {
        grid,
        blocksPending,
        activeTetrominoGrid,
        activeTetrominoPosition
      } = player;

      // XXX: The appended blocks might result in trimming existing blocks, by
      // lifting them higher than the well permits. This is odd because it
      // "trims" some blocks
      let newGrid = appendBlocksToGrid(grid, blocksPending);

      // Push active Tetromino up if necessary
      if (
        isPositionAvailable(
          newGrid,
          activeTetrominoGrid,
          activeTetrominoPosition
        )
      ) {
        return updatePlayer(state, userId, {
          grid: newGrid,
          blocksPending: []
        });
      }

      // Receiving rows of blocks from enemy might cause the active Tetromino
      // to overlap with the grid, so in some cases it will be pushed up
      // mid-drop to avoid collisions. The next DROP action will instantly
      // transfer active Tetromino to wall grid in these cases
      const newPosition = getBottomMostPosition(
        newGrid,
        activeTetrominoGrid,
        activeTetrominoPosition
      );

      return updatePlayer(state, userId, {
        // The next `DROP` event will determine whether the well is full and
        // if the game is over or not
        grid: newGrid,
        blocksPending: [],
        activeTetrominoPosition: newPosition
      });
    }

    case 'MOVE_LEFT':
    case 'MOVE_RIGHT': {
      const direction = action.type === 'MOVE_LEFT' ? -1 : 1;
      const player = getPlayer(state, userId);
      const { grid, activeTetrominoGrid, activeTetrominoPosition } = player;
      const newPosition = Object.assign({}, activeTetrominoPosition, {
        x: activeTetrominoPosition.x + direction
      });

      // Attempting to move the Tetromino outside the Well bounds or over landed
      // Tetrominoes will be ignored
      if (!isPositionAvailable(grid, activeTetrominoGrid, newPosition)) {
        return state;
      }

      return updatePlayer(state, userId, {
        activeTetrominoPosition: newPosition
      });
    }

    case 'ROTATE': {
      const player = getPlayer(state, userId);
      const { grid, activeTetrominoGrid, activeTetrominoPosition } = player;
      const newGrid = rotate(activeTetrominoGrid);

      // If the rotation causes the active Tetromino to go outside of the
      // Well bounds, its position will be adjusted to fit inside
      const newPosition = fitTetrominoPositionInWellBounds(
        grid,
        newGrid,
        activeTetrominoPosition
      );

      // If the rotation causes a collision with landed Tetrominoes than it won't
      // be applied
      if (!isPositionAvailable(grid, newGrid, newPosition)) {
        return state;
      }

      return updatePlayer(state, userId, {
        activeTetrominoGrid: newGrid,
        activeTetrominoPosition: newPosition
      });
    }

    case 'ENABLE_ACCELERATION': {
      const player = getPlayer(state, userId);

      if (player.dropAcceleration) {
        return state;
      }

      return updatePlayer(state, userId, {
        dropAcceleration: true
      });
    }

    case 'DISABLE_ACCELERATION': {
      const player = getPlayer(state, userId);

      if (!player.dropAcceleration) {
        return state;
      }

      return updatePlayer(state, userId, {
        dropAcceleration: false
      });
    }

    case 'PING': {
      const { time } = action.payload;

      return updatePlayer(state, userId, {
        ping: time
      });
    }

    default:
      return state;
  }
}

export function getBlankGame({
  id,
  user,
  dropFrames = DROP_FRAMES_DEFAULT
}: {
  id: GameId,
  user: User,
  dropFrames?: number
}): Game {
  return {
    id,
    players: [getBlankPlayer(id, user)],
    dropFrames
  };
}

export function getBlankPlayer(gameId: GameId, user: User): Player {
  return {
    user,
    lastActionId: 0,
    status: 'PENDING',
    losses: 0,
    ...getBlankPlayerRound({ gameId })
  };
}

export function getBlankPlayerRound({
  gameId,
  round = 0,
  drops = 0
}: {
  gameId: GameId,
  round?: number,
  drops?: number
} = {}) {
  return {
    drops: 0,
    score: 0,
    lines: 0,
    grid: generateEmptyGrid(WELL_ROWS, WELL_COLS),
    blocksCleared: [],
    blocksPending: [],
    ...getNextPlayerTetromino({ gameId, round, drops }),
    dropAcceleration: false,
    ...getBlankPlayerEffects()
  };
}

export function getNextPlayerTetromino({
  gameId,
  round = 0,
  drops = 0
}: {
  gameId: GameId,
  round?: number,
  drops?: number
} = {}) {
  // Generate random Tetromino sequence per game round
  const roundId = (parseInt(gameId, 16) * (round + 1)).toString(16);
  const activeTetromino = getNextTetromino(roundId, drops);

  return {
    activeTetromino,
    activeTetrominoGrid: SHAPES[activeTetromino],
    activeTetrominoPosition: getInitialPositionForTetromino(
      activeTetromino,
      WELL_COLS
    ),
    nextTetromino: getNextTetromino(roundId, drops + 1)
  };
}

export function stripGameEffects(game: Game): Game {
  return {
    ...game,
    players: game.players.map(player => ({
      ...player,
      // Strip effects to avoid running them on page load
      ...getBlankPlayerEffects()
    }))
  };
}

export function isPlayer(game: Game, curUser: ?User): boolean {
  if (!curUser) {
    return false;
  }

  // Flow requires us to store the current user's id aside, as the curUser
  // object may change by the time the some callback is called. Smart!
  const { id } = curUser;

  return game.players.some(p => p.user.id === id);
}

export function getPlayer(game: Game, userId: UserId): Player {
  const player = find(game.players, p => p.user.id === userId);

  if (!player) {
    throw new Error(`Player with userId ${userId} does not exist`);
  }

  return player;
}

export function getCurPlayer(game: Game, curUser: ?User): Player {
  if (!game.players.length) {
    throw new Error('Games must have at least one player');
  }

  return curUser && isPlayer(game, curUser)
    ? getPlayer(game, curUser.id)
    : game.players[0];
}

export function getOtherPlayer(game: Game, curPlayer: Player): ?Player {
  // NOTE: This only works with max 2 players per game
  return find(game.players, p => p !== curPlayer);
}

export function allPlayersReady(game: Game) {
  return (
    game.players.filter(p => p.status === 'READY').length ===
    game.players.length
  );
}

export function addUserToGame(game: Game, user: User): Game {
  const { id, players } = game;

  return {
    ...game,
    players: [...players, getBlankPlayer(id, user)]
  };
}

export function updatePlayer(
  game: Game,
  userId: UserId,
  attrs: $Shape<Player>
): Game {
  const { players } = game;
  const player = getPlayer(game, userId);
  const playerIndex = players.indexOf(player);

  return {
    ...game,
    players: [
      ...players.slice(0, playerIndex),
      { ...player, ...attrs },
      ...players.slice(playerIndex + 1)
    ]
  };
}

// This function can have three responses:
// - 0, which means the action points to game state
// - <0, which means the action is from the past and will be discarded
// - >0, which means the action is detached and backfill is required
export function getGameActionOffset(game: Game, action: GameAction): number {
  // There's no previous player action to follow when user just joined
  if (action.type === 'JOIN_GAME') {
    return 0;
  }

  const { userId, actionId, prevActionId } = action.payload;
  const player = find(game.players, p => p.user.id === userId);

  // Sometimes we get actions from players that aren't found in the state
  // snapshot, because it's from a time before they joined
  if (!player) {
    return actionId;
  }

  return prevActionId - player.lastActionId;
}

export function getLineCount(game: Game) {
  return game.players.reduce((total, p) => total + p.lines, 0);
}

function rewardClearedBlocks(game: Game, userId: UserId): Game {
  const { dropFrames } = game;
  const player = getPlayer(game, userId);
  const { score, lines, blocksCleared, dropAcceleration } = player;

  // TODO: Calculate cells in Tetromino. All current Tetrominoes have 4 cells
  const cells = 4;

  // Rudimentary scoring logic, no T-Spin and combo bonuses
  let points = dropAcceleration ? cells * 2 : cells;
  if (blocksCleared.length) {
    points += LINE_CLEAR_BONUSES[blocksCleared.length - 1] * (lines + 1);
  }

  return {
    ...updatePlayer(game, userId, {
      score: score + points,
      lines: lines + blocksCleared.length
    }),
    // Increase speed whenever a line is cleared (fast game)
    dropFrames: blocksCleared.length
      ? dropFrames - DROP_FRAMES_DECREMENT
      : dropFrames
  };
}

function getGameRound(game: Game) {
  return game.players.reduce((acc, next) => acc + next.losses, 0);
}

function sendClearedBlocksToEnemy(
  game: Game,
  userId: UserId,
  unclearedGrid: WellGrid,
  rowsCleared: Array<number>
): Game {
  const curPlayer = getPlayer(game, userId);
  const enemy = getOtherPlayer(game, curPlayer);
  if (!enemy) {
    return game;
  }

  const { flashNay } = enemy;
  const blocksPending = overrideBlockIds(
    getBlocksFromGridRows(unclearedGrid, rowsCleared),
    getNextCellId(enemy)
  );

  return updatePlayer(game, enemy.user.id, {
    blocksPending: [...enemy.blocksPending, ...blocksPending],
    flashNay: altFlashClass(flashNay)
  });
}

function altFlashClass(flashSuffix: ?FlashSuffix): FlashSuffix {
  return flashSuffix === 'b' ? 'a' : 'b';
}

const QUAKE_A = ['a1', 'a2', 'a3', 'a4'];
const QUAKE_B = ['b1', 'b2', 'b3', 'b4'];

function altQuakeClass(
  quakeSuffix: ?QuakeSuffix,
  magnitude: number
): QuakeSuffix {
  if ([1, 2, 3, 4].indexOf(magnitude) === -1) {
    throw new Error(`Invalid quake magnitute: ${magnitude}`);
  }
  const offset = magnitude - 1;

  return quakeSuffix === QUAKE_B[offset] ? QUAKE_A[offset] : QUAKE_B[offset];
}

function getBlankPlayerEffects() {
  return {
    flashYay: null,
    flashNay: null,
    quake: null,
    ping: null
  };
}

function bumpActionId(game: Game, userId: UserId, actionId: ActionId): Game {
  return updatePlayer(game, userId, { lastActionId: actionId });
}
