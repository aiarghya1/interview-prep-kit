import type { Kit } from './schema.js';
import { buildSchedule } from './schedule.js';

/** Same kit, different number of days: research is reused, only the schedule changes. */
export function rescheduleKit(kit: Kit, days: number): Kit {
  return {
    ...kit,
    schedule: buildSchedule({ days, requirements: kit.role.requirements, questions: kit.questions }),
  };
}
