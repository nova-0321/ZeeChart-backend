/** What Undo or Redo does: the batch, and what it did in a sentence. */
export class UndoStepDto {
  batchId: string;
  summary: string;
}

/** What Undo and Redo would do now (null: nothing). */
export class UndoStateDto {
  undo: UndoStepDto | null;
  redo: UndoStepDto | null;
}
