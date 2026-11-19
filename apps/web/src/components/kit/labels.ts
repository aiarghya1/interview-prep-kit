import type { QuestionCategory } from '@kit/core/schema';

export const CATEGORIES: QuestionCategory[] = ['technical', 'behavioural', 'system-design', 'company-fit'];
export const CATEGORY_LABEL: Record<QuestionCategory, string> = {
  technical: 'Technical',
  behavioural: 'Behavioural',
  'system-design': 'System design',
  'company-fit': 'Company fit',
};

export const STEP_LABEL: Record<string, string> = {
  queued: 'Queued',
  extract: 'Reading the job description',
  crawl: 'Crawling the company site',
  discussion: 'Searching public interview discussion',
  hiring: 'Working out the interview process',
  brief: 'Writing the company brief',
  'questions:technical': 'Technical questions',
  'questions:behavioural': 'Behavioural questions',
  'questions:system-design': 'System design questions',
  'questions:company-fit': 'Company fit questions',
  coverage: 'Checking every requirement is covered',
  flashcards: 'Writing flashcards',
  schedule: 'Building your study schedule',
  validate: 'Checking the kit',
};

export const STEP_ORDER = [
  'extract',
  'crawl',
  'discussion',
  'hiring',
  'brief',
  'questions:technical',
  'questions:behavioural',
  'questions:system-design',
  'questions:company-fit',
  'coverage',
  'flashcards',
  'schedule',
  'validate',
];

export const ERROR_HELP: Record<string, string> = {
  LLM_NOT_CONFIGURED: 'The AI provider is not configured on the server.',
  LLM_RATE_LIMITED: "The AI provider's free quota is used up for now. Try again later.",
  LLM_UNAVAILABLE: 'The AI provider could not be reached. This is usually temporary.',
  EXTRACTION_FAILED: "We couldn't read requirements out of that description. Try pasting the full posting.",
  INVALID_INPUT: 'The description or settings were not valid.',
  KIT_INVALID: 'The generated kit failed our structure checks.',
  TIMEOUT: 'Generation took too long.',
};

export const NOTE_TONE = (note: string): 'warn' | 'info' =>
  /^(COMPANY_UNREACHABLE|INVALID_COMPANY_URL|Thin job description|Template questions)/.test(note) ? 'warn' : 'info';

export function prettyNote(note: string): string {
  return note.replace(/^(COMPANY_UNREACHABLE|INVALID_COMPANY_URL|NO_HIRING_PAGE|NO_PUBLIC_DISCUSSION):\s*/, '');
}
