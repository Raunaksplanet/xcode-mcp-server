import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { logger } from './lib/logger.js';
import { loadConfig, type ResolvedConfig } from './lib/config.js';
import { killAllChildProcesses } from './lib/process_manager.js';
import { registerProjectTools } from './tools/project.js';
import { registerBuildTools } from './tools/build.js';
import { registerSimulatorTools } from './tools/simulator.js';
import { registerTestingTools } from './tools/testing.js';
import { registerCodeTools } from './tools/code.js';
import { registerSigningTools } from './tools/signing.js';
import { registerDiagnosticsTools } from './tools/diagnostics.js';
import { registerProjectResources } from './resources/project_structure.js';
import { registerBuildLogResources } from './resources/build_log.js';
import { registerPrompts } from './prompts/fix_build_error.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

export interface ResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  handler: (uri: string) => Promise<{ contents: Array<{ uri: string; text: string; mimeType?: string }> }>;
}

export interface PromptDefinition {
  name: string;
  description: string;
  arguments: Array<{ name: string; description?: string; required?: boolean }>;
  handler: (args: Record<string, string>) => Promise<{ messages: Array<{ role: string; content: { type: string; text: string } }> }>;
}

export class XcodeMCPServer {
  private server: Server;
  private tools = new Map<string, ToolDefinition>();
  private resources = new Map<string, ResourceDefinition>();
  private prompts = new Map<string, PromptDefinition>();
  public config!: ResolvedConfig;

  constructor() {
    this.server = new Server(
      {
        name: 'xcode-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      }
    );

    this.setupRequestHandlers();
    this.setupLifecycleHandlers();
  }

  private setupRequestHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const toolList = Array.from(this.tools.values()).map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return { tools: toolList };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const tool = this.tools.get(toolName);
      if (!tool) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
      }
      try {
        return await tool.handler(request.params.arguments || {});
      } catch (error) {
        logger.error(`Tool ${toolName} error:`, error);
        if (error instanceof McpError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'TOOL_ERROR',
            message: msg,
            suggestion: 'Check the tool arguments and try again.',
          }) }],
          isError: true,
        };
      }
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resourceList = Array.from(this.resources.values()).map(r => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
      return { resources: resourceList };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const resource = this.resources.get(uri);
      if (!resource) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown resource: ${uri}`);
      }
      return await resource.handler(uri);
    });

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      const promptList = Array.from(this.prompts.values()).map(p => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments,
      }));
      return { prompts: promptList };
    });

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const promptName = request.params.name;
      const prompt = this.prompts.get(promptName);
      if (!prompt) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown prompt: ${promptName}`);
      }
      return await prompt.handler(request.params.arguments || {});
    });
  }

  private setupLifecycleHandlers(): void {
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down...');
      killAllChildProcesses();
      await this.server.close();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down...');
      killAllChildProcesses();
      await this.server.close();
      process.exit(0);
    });

    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception:', error);
      killAllChildProcesses();
    });

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection:', reason);
    });
  }

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  registerResource(resource: ResourceDefinition): void {
    this.resources.set(resource.uri, resource);
  }

  registerPrompt(prompt: PromptDefinition): void {
    this.prompts.set(prompt.name, prompt);
  }

  async init(): Promise<void> {
    logger.info('Loading configuration...');
    this.config = await loadConfig();
    logger.info(`Config loaded. Project: ${this.config.projectPath}`);

    if (this.config.defaultScheme) {
      logger.info(`Default scheme: ${this.config.defaultScheme}`);
    }
  }

  registerAllTools(): void {
    registerProjectTools(this);
    registerBuildTools(this);
    registerSimulatorTools(this);
    registerTestingTools(this);
    registerCodeTools(this);
    registerSigningTools(this);
    registerDiagnosticsTools(this);
    registerProjectResources(this);
    registerBuildLogResources(this);
    registerPrompts(this);
  }

  async start(): Promise<void> {
    this.registerAllTools();
    logger.info(`Registered ${this.tools.size} tools, ${this.resources.size} resources, ${this.prompts.size} prompts`);

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('xcode-mcp server started on stdio');
  }
}
