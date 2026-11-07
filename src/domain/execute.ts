import type { PressAction, SetPlan } from '@/domain/planSetTo';

export type ExecuteResult = {
  status: 'done' | 'cancelled' | 'failed';
  completedPresses: number;
  stoppedAt: number;
  wanted: number;
  error?: string;
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
): Promise<ExecuteResult> {
  let setpoint = startSetpoint;
  let completedPresses = 0;
  const total = plan.actions.length;
  for (let index = 0; index < plan.actions.length; index += 1) {
    const action = plan.actions[index];
    if (deps.isCancelled()) {
      return { status: 'cancelled', completedPresses, stoppedAt: setpoint, wanted: plan.target };
    }
    deps.onProgress(index + 1, total, action);
    if (index > 0) {
      const aborted = await deps.sleep(deps.delayMs, deps.isCancelled);
      if (aborted || deps.isCancelled()) {
        return { status: 'cancelled', completedPresses, stoppedAt: setpoint, wanted: plan.target };
      }
    }
    try {
      if (action.direction === 'up') {
        await deps.pressUp();
      } else {
        await deps.pressDown();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The press failed.';
      return {
        status: 'failed',
        completedPresses,
        stoppedAt: setpoint,
        wanted: plan.target,
        error: message,
      };
    }
    completedPresses += 1;
    if (action.kind === 'adjust' && action.setpointAfter !== null) {
      setpoint = action.setpointAfter;
    }
    deps.onCommitted(action);
  }
  return { status: 'done', completedPresses, stoppedAt: setpoint, wanted: plan.target };
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
