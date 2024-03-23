import pall from 'p-all';
import { z } from 'zod';

import { protectedProcedure, router } from '@/lib/trpc/server';
import { enrichCell } from '@/registry/agent/enrich';
import { preprocessPrompt } from '@/registry/agent/preprocessor';
import { inngest } from '@/registry/inngest/client';
import { browse } from '@/registry/search/browse';
import { generateQueryQuestions } from '@/registry/search/research';
import { retrieve } from '@/registry/search/retrieve';
import { search } from '@/registry/search/search';
import { TableCell } from '@/registry/types';

export const queryRouter = router({
  run: protectedProcedure
    .input(
      z.object({
        prompt: z.string().trim(),
      }),
    )
    .mutation(async ({ input }) => {
      const preprocessed = await preprocessPrompt({ userPrompt: input.prompt });

      const query = await generateQueryQuestions({
        query: preprocessed.objective,
      });
      const results = await search(query);
      const browseRes = await browse({ results });

      const nodeType = `${preprocessed.mainField.name} - ${preprocessed.mainField.description}`;
      const retrieveRes = await retrieve({
        results: browseRes,
        nodeType,
      });

      const promises: (() => Promise<TableCell | undefined>)[] = [];

      // retrieve all other cells async
      for (let row = 0; row < retrieveRes.length; row++) {
        for (let column = 0; column < preprocessed.fields.length; column++) {
          const field = preprocessed.fields[column];
          promises.push(async () => {
            const cell = await enrichCell({
              query: `${retrieveRes[row].title} - ${field.name} - ${field.description}`,
              content: [retrieveRes[row]],
            });
            return cell;
          });
        }
      }

      const cells = await pall(promises, {
        concurrency: 10,
        stopOnError: false,
      });

      const table: (TableCell | undefined)[][] = Array(retrieveRes.length)
        .fill(undefined)
        // add an extra column for the initial value
        .map(() => Array(preprocessed.fields.length + 1).fill(undefined));

      // construct the table from outputs
      for (let row = 0; row < retrieveRes.length; row++) {
        const cell: TableCell = {
          text: retrieveRes[row].title,
          confidence: 1,
          sources: retrieveRes[row].sources,
        };
        table[row][0] = cell;
        for (let column = 0; column < preprocessed.fields.length; column++) {
          table[row][column + 1] =
            cells[row * preprocessed.fields.length + column];
        }
      }

      return {
        columns: [preprocessed.mainField, ...preprocessed.fields],
        table,
      };
    }),
  queue: protectedProcedure
    .input(
      z.object({
        prompt: z.string().trim(),
      }),
    )
    .mutation(async ({ input }) => {
      await inngest.send({ name: 'app/query.run', data: input });
    }),
});
