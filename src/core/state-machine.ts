export type AgentState = "idle" | "active" | "sleeping" | "waiting" | "error";

export interface StateTransition {
  from: AgentState;
  to: AgentState;
  reason: string;
  timestamp: number;
}

type StateListener = (
  state: AgentState,
  transition: StateTransition,
) => void;

const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  idle: ["active"],
  active: ["idle", "sleeping", "waiting", "error"],
  sleeping: ["active", "error"],
  waiting: ["active", "error"],
  error: ["idle", "active"],
};

export class AgentStateMachine {
  private _state: AgentState = "idle";
  private _history: StateTransition[] = [];
  private _listeners: StateListener[] = [];

  get state(): AgentState {
    return this._state;
  }

  get history(): readonly StateTransition[] {
    return this._history;
  }

  transition(to: AgentState, reason: string): void {
    const valid = VALID_TRANSITIONS[this._state];
    if (!valid.includes(to)) {
      throw new Error(
        `Invalid state transition: ${this._state} → ${to}`,
      );
    }

    const transition: StateTransition = {
      from: this._state,
      to,
      reason,
      timestamp: Date.now(),
    };

    this._state = to;
    this._history.push(transition);
    if (this._history.length > 200) {
      this._history = this._history.slice(-100);
    }

    for (const listener of this._listeners) {
      listener(to, transition);
    }
  }

  onTransition(listener: StateListener): () => void {
    this._listeners.push(listener);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== listener);
    };
  }
}
