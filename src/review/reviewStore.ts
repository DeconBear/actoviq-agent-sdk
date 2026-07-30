import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomic } from '../storage/atomicJsonWrite.js';
import { assertSafeStorageSegment } from '../storage/pathSafety.js';
import type { ReviewComment, ThreadReview } from './types.js';

export class ReviewStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly root: string) {}

  async read(sessionId: string): Promise<ThreadReview> {
    try {
      return JSON.parse(await readFile(this.file(sessionId), 'utf8')) as ThreadReview;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const now = new Date().toISOString();
      return {
        version: 1,
        revision: 0,
        sessionId,
        comments: [],
        createdAt: now,
        updatedAt: now,
      };
    }
  }

  addComment(
    sessionId: string,
    input: Pick<ReviewComment, 'filePath' | 'line' | 'side' | 'body'>,
  ): Promise<ThreadReview> {
    return this.mutate(sessionId, review => {
      const now = new Date().toISOString();
      review.comments.push({
        id: randomUUID(),
        filePath: input.filePath,
        line: input.line,
        side: input.side,
        body: input.body.trim(),
        resolved: false,
        createdAt: now,
        updatedAt: now,
      });
      return review;
    });
  }

  resolveComment(sessionId: string, commentId: string, resolved = true): Promise<ThreadReview> {
    return this.mutate(sessionId, review => {
      const comment = review.comments.find(item => item.id === commentId);
      if (!comment) throw new Error(`Review comment not found: ${commentId}`);
      comment.resolved = resolved;
      comment.updatedAt = new Date().toISOString();
      return review;
    });
  }

  private mutate(
    sessionId: string,
    mutation: (review: ThreadReview) => ThreadReview,
  ): Promise<ThreadReview> {
    const result = this.queue.then(async () => {
      const current = await this.read(sessionId);
      const next = mutation(structuredClone(current));
      next.revision = current.revision + 1;
      next.updatedAt = new Date().toISOString();
      const file = this.file(sessionId);
      await mkdir(path.dirname(file), { recursive: true });
      await writeJsonAtomic(file, next);
      return structuredClone(next);
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private file(sessionId: string): string {
    return path.join(this.root, `${assertSafeStorageSegment('sessionId', sessionId)}.json`);
  }
}
