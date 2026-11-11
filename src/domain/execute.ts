import type { PressAction, SetPlan } from '@/domain/planSetTo';
import { runPressSession, type CommandSource } from '@/domain/pressSession';

export type ExecuteResult = {
  status: 'done' | 'cancelled' | 'failed' | 'ambiguous';
  completedPresses: number;
  stoppedAt: number;
  wanted: number;
  error?: string;
  notifyCheck: boolean;
};

export type ExecuteDeps = {
  pressUp: () => Promise<void>;
  pressDown: () => Promise<void>;
  delayMs: number;
  sleep: (ms: number, isCancelled: () => boolean) => Promise<boolean>;
  isCancelled: () => boolean;
  onProgress: (index: number, total: number, action: PressAction) => void;
  onCommitted: (action: PressAction) => void;
};

type OkPlan = Extract<SetPlan, { ok: true }>;

export async function executePlan(
  plan: OkPlan,
  startSetpoint: number,
  deps: ExecuteDeps,
  source: CommandSource = { kind: 'manual' },
): Promise<ExecuteResult> {
  let completedPresses = 0;
  const settled = await runPressSession({
    current: startSetpoint,
    target: plan.target,
    source,
    mode: 'demo',
    plan,
    delayMs: deps.delayMs,
    press: async (direction) => {
      if (direction === 'up') {
        await deps.pressUp();
        return;
      }
      await deps.pressDown();
    },
    sleep: deps.sleep,
    beforeSend: async (index, isCancelled) => {
      const action = plan.actions[index];
      if (action) {
        deps.onProgress(index + 1, plan.actions.length, action);
      }
      if (index === 0) {
        return isCancelled();
      }
      return false;
    },
    isCancelled: deps.isCancelled,
    isInterrupted: () => false,
    onSession: () => undefined,
    onCommitted: (action) => {
      completedPresses += 1;
      deps.onCommitted(action);
    },
  });
  if (settled.status === 'done') {
    return {
      status: 'done',
      completedPresses,
      stoppedAt: settled.stoppedAt,
      wanted: settled.wanted,
      notifyCheck: false,
    };
  }
  if (settled.status === 'cancelled') {
    return {
      status: 'cancelled',
      completedPresses,
      stoppedAt: settled.stoppedAt,
      wanted: settled.wanted,
      notifyCheck: false,
    };
  }
  if (settled.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      completedPresses,
      stoppedAt: settled.stoppedAt,
      wanted: settled.wanted,
      error: settled.reason,
      notifyCheck: true,
    };
  }
  return {
    status: 'failed',
    completedPresses,
    stoppedAt: settled.stoppedAt,
    wanted: settled.wanted,
    error: settled.reason,
    notifyCheck: false,
  };
}

export function sleepUnlessCancelled(ms: number, isCancelled: () => boolean): Promise<boolean> {
  if (ms <= 0) {
    return Promise.resolve(isCancelled());
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (isCancelled()) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - started >= ms) {
        clearInterval(timer);
        resolve(false);
      }
    }, 40);
  });
}
