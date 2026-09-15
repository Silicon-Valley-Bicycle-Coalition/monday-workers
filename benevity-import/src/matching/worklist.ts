import type { MondayClient } from '../monday/client';
import type { BenevityImportConfig } from '../types';

export interface WorklistItemInput {
  reason: string;
  name: string;
  email: string;
  company: string;
  amount: number;
  date: string;
}

export async function createWorklistItem(
  mondayClient: MondayClient,
  config: BenevityImportConfig,
  input: WorklistItemInput
): Promise<void> {
  const boardId = config.monday.boards.benevityUploads;
  if (boardId === null) {
    throw new Error('config: monday.boards.benevityUploads is not configured');
  }
  const { worklistColumns, worklistGroupId } = config.benevityImport.uploadsBoard;

  await mondayClient.createItem(
    boardId,
    input.name || input.company || 'Benevity row needs review',
    {
      [worklistColumns.reason]: input.reason,
      [worklistColumns.email]: input.email,
      [worklistColumns.company]: input.company,
      [worklistColumns.amount]: input.amount,
      [worklistColumns.date]: { date: input.date },
    },
    worklistGroupId
  );
}
