import { BaseSource, Context, DduItem, Denops, Item, LSP } from "../ddu_source_lsp/deps.ts";
import { lspRequest, LspResult, Method } from "../ddu_source_lsp/request.ts";
import { Client, ClientName, getClientName, getClients } from "../ddu_source_lsp/client.ts";
import { makePositionParams, TextDocumentPositionParams } from "../ddu_source_lsp/params.ts";
import { getCwd, locationToItem, printError, uriToFname } from "../ddu_source_lsp/util.ts";
import { ActionData } from "../@ddu-kinds/lsp.ts";
import { isValidItem } from "../ddu_source_lsp/handler.ts";

type ReferenceParams = TextDocumentPositionParams & {
  context: LSP.ReferenceContext;
};

type Params = {
  clientName: ClientName | "";
  includeDeclaration: boolean;
  showLine: boolean;
};

export class Source extends BaseSource<Params> {
  kind = "lsp";

  gather(args: {
    denops: Denops;
    sourceParams: Params;
    context: Context;
    input: string;
    parent?: DduItem;
  }): ReadableStream<Item<ActionData>[]> {
    const { denops, sourceParams, context: ctx } = args;
    const { includeDeclaration, showLine, locationPaddingWidth } = sourceParams;
    const method: Method = "textDocument/references";

    return new ReadableStream({
      async start(controller) {
        try {
          const clientName = await getClientName(denops, sourceParams);
          const clients = await getClients(denops, clientName, ctx.bufNr);
          const cwd = await getCwd(denops, ctx.winId);

          await Promise.all(clients.map(async (client) => {
            const params = await makePositionParams(
              denops,
              ctx.bufNr,
              ctx.winId,
              client.offsetEncoding,
            ) as ReferenceParams;
            params.context = { includeDeclaration };
            const result = await lspRequest(
              denops,
              client,
              method,
              params,
              ctx.bufNr,
            );
            const items = await parseResult(result, client, ctx.bufNr, method, cwd, denops, showLine, locationPaddingWidth);
            controller.enqueue(items);
          }));
        } catch (e) {
          printError(denops, e, "source-lsp_references");
        } finally {
          controller.close();
        }
      },
    });
  }

  params(): Params {
    return {
      clientName: "",
      includeDeclaration: true,
      showLine: false,
      locationPaddingWidth: 30
    };
  }
}

async function parseResult(
  result: LspResult,
  client: Client,
  bufNr: number,
  method: Method,
  cwd: string,
  denops: Denops,
  showLine: boolean,
  locationPaddingWidth: number
): Promise<Item<ActionData>[]> {
  /**
   * Reference:
   * https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_references
   */
  const locations = result as LSP.Location[] | null;
  if (!locations) {
    return [];
  }

  const context = { client, bufNr, method };

  // Fetch unique files
  const fileContents = new Map<string, string[]>();
  if (showLine) {
    for (const loc of locations) {
      const path = uriToFname(loc.uri);
      if (!fileContents.has(path)) {
        if (await denops.call("bufloaded", path)) {
          fileContents.set(path, await denops.call("getbufline", path, 1, "$") as string[]);
        } else {
          try {
            fileContents.set(path, await denops.call("readfile", path) as string[]);
          } catch {
            fileContents.set(path, []);
          }
        }
      }
    }
  }

  return locations
    .map((location) => {
      const path = uriToFname(location.uri);
      const line = location.range.start.line;
      const content = fileContents.get(path);
      const text = content && content[line] ? content[line].trim() : null;
      return locationToItem(location, cwd, context, text, locationPaddingWidth);
    })
    .filter(isValidItem);
}
