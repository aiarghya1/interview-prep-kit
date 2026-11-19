import mongoose, { Schema, type InferSchemaType } from 'mongoose';

const UserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true },
);
export const User = mongoose.model('User', UserSchema);

const ProgressSchema = new Schema({ step: String, status: String, message: String, at: String }, { _id: false });

/**
 * One document per kit. `kit` holds the Appendix A structure as-is; `version`
 * is bumped on every write to it and used as an optimistic-concurrency guard,
 * so a slow regeneration can't overwrite edits that landed while it ran.
 */
const KitSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: ['queued', 'running', 'ready', 'failed'], required: true, index: true },
    input: { jd: String, company_url: String, days: Number },
    inputHash: { type: String, required: true },
    title: String,
    company: String,
    kit: { type: Schema.Types.Mixed, default: null },
    version: { type: Number, default: 0 },
    highWater: { q: { type: Number, default: 0 }, f: { type: Number, default: 0 } },
    progress: { type: [ProgressSchema], default: [] },
    error: { code: String, message: String },
    corpus: { type: Schema.Types.Mixed, select: false },
    practice: { type: Schema.Types.Mixed, default: {} },
    regen: {
      section: String,
      status: { type: String, enum: ['running', 'done', 'failed'] },
      startedAt: Date,
      finishedAt: Date,
      message: String,
    },
    scheduleStale: { type: Boolean, default: false },
    startedAt: Date,
    finishedAt: Date,
  },
  { timestamps: true, minimize: false },
);
KitSchema.index({ userId: 1, inputHash: 1 });
export const KitModel = mongoose.model('Kit', KitSchema);
export type KitDocShape = InferSchemaType<typeof KitSchema> & { _id: mongoose.Types.ObjectId };
