import { BaseSource, GatherArguments, Item, LSP } from "../ddu_source_lsp/deps.ts";
import { lspRequest, LspResult, Method } from "../ddu_source_lsp/request.ts";
import { ClientName, getClientName, getClients } from "../ddu_source_lsp/client.ts";
import { makeTextDocumentIdentifier } from "../ddu_source_lsp/params.ts";
import { printError, SomeRequired, uriToFname } from "../ddu_source_lsp/util.ts";
import { ActionData, ItemContext } from "../@ddu-kinds/lsp.ts";
import { isValidItem } from "../ddu_source_lsp/handler.ts";
import { KindName } from "../@ddu-filters/converter_lsp_symbol.ts";

type Params = {
  clientName: ClientName | "";
  displayContainerName: boolean;
  symbolNameWidth: number;
};

type ItemWithAction = SomeRequired<Item<ActionData>, "action">;

export class Source extends BaseSource<Params> {
  kind = "lsp";

  gather(args: GatherArguments<Params>): ReadableStream<Item<ActionData>[]> {
    const { denops, sourceParams, context: ctx } = args;
    const { displayContainerName, symbolNameWidth } = sourceParams;
    const method: Method = "textDocument/documentSymbol";

    return new ReadableStream({
      async start(controller) {
        try {
	  const clientName = await getClientName(denops, sourceParams);
	  const clients = await getClients(denops, clientName, ctx.bufNr);

	  const params = {
	    textDocument: await makeTextDocumentIdentifier(denops, ctx.bufNr),
	  };
	  await Promise.all(clients.map(async (client) => {
	    const result = await lspRequest(
	      denops,
	      client,
	      method,
	      params,
	      ctx.bufNr,
	    );
	    const items = parseResult(
	      result,
	      { client, bufNr: ctx.bufNr, method },
	      displayContainerName,
	      symbolNameWidth,
	    );
	    controller.enqueue(items);
	  }));
        } catch (e) {
          printError(denops, e, "source-lsp_documentSymbol");
        } finally {
          controller.close();
        }
      },
    });
  }

  params(): Params {
    return {
      clientName: "",
      displayContainerName: false,
      symbolNameWidth: 30,
    };
  }
}

function symbolToItem(
  symbol: LSP.DocumentSymbol | LSP.SymbolInformation,
  parentPath: string[],
  context: ItemContext,
  symbolNameWidth: number,
  containerName?: string,
): ItemWithAction {
  const kindName = KindName[symbol.kind];
  const kind = `[${kindName}]`.padEnd(15, " ");
  const name = containerName
    ? `${symbol.name.padEnd(symbolNameWidth)} [${containerName}]`
    : symbol.name;
  return {
    word: `${kind} ${name}`,
    action: {
      ...(isDucumentSymbol(symbol)
        ? {
          bufNr: context.bufNr,
          range: symbol.selectionRange,
        }
        : {
          path: uriToFname(symbol.location.uri),
          range: symbol.location.range,
        }),
      context,
    },
    isExpanded: false,
    level: parentPath.length,
    treePath: [...parentPath, symbol.name],
    isTree: false,
    data: symbol,
  };
}

function parseResult(
  result: LspResult,
  context: ItemContext,
  displayContainerName: boolean,
  symbolNameWidth: number,
): Item<ActionData>[] {
  /**
   * Reference:
   * https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_documentSymbol
   */
  const symbols = result as
    | LSP.DocumentSymbol[]
    | LSP.SymbolInformation[]
    | null;
  if (!symbols) {
    return [];
  }

  const items: ItemWithAction[] = [];
  const setItems = (
    parentPath: string[],
    symbols: LSP.DocumentSymbol[] | LSP.SymbolInformation[],
    parentName: string = "",
  ) => {
    for (const symbol of symbols) {
      const containerName = displayContainerName
        ? (isDucumentSymbol(symbol) ? parentName : symbol.containerName)
        : undefined;

      const item = symbolToItem(symbol, parentPath, context, symbolNameWidth, containerName);
      if (isDucumentSymbol(symbol) && symbol.children) {
	const parentNamePrefix: string = containerName ? `${containerName}.` : "";
        setItems(item.treePath as string[], symbol.children, `${parentNamePrefix}${symbol.name}`);
      }
      if (isValidItem(item)) {
        items.push(item);
      }
    }
  };

  setItems([], symbols);

  items.sort((a, b) => {
    const aStart = a.action.range.start;
    const bStart = b.action.range.start;
    if (aStart.line !== bStart.line) {
      return aStart.line - bStart.line;
    }
    return aStart.character - bStart.character;
  });
  return items;
}

function isDucumentSymbol(
  symbol: LSP.SymbolInformation | LSP.DocumentSymbol,
): symbol is LSP.DocumentSymbol {
  return "range" in symbol;
}
