import type { XcodeMCPServer } from '../server.js';

export function registerPrompts(server: XcodeMCPServer): void {
  server.registerPrompt({
    name: 'fix_build_error',
    description: 'Given an Xcode build error and relevant file contents, generate a fix',
    arguments: [
      {
        name: 'error_message',
        description: 'The build error message from Xcode',
        required: true,
      },
      {
        name: 'file_path',
        description: 'The file containing the error',
        required: true,
      },
      {
        name: 'file_content',
        description: 'The content of the file with the error',
        required: true,
      },
    ],
    handler: async (args) => {
      const errorMessage = args.error_message || 'Unknown error';
      const filePath = args.file_path || 'Unknown file';
      const fileContent = args.file_content || '';

      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `I'm getting a build error in my Xcode project and need help fixing it.

## Error
\`\`\`
${errorMessage}
\`\`\`

## File: ${filePath}
\`\`\`swift
${fileContent}
\`\`\`

Please analyze this build error and provide:
1. What is causing the error
2. The exact fix needed (show the corrected code)
3. Any related changes that might be needed

Focus on the specific error message and the code shown. Suggest the minimal change to fix it.`,
          },
        }],
      };
    },
  });

  server.registerPrompt({
    name: 'create_swift_feature',
    description: 'Given a feature description, generate Swift implementation code',
    arguments: [
      {
        name: 'feature_description',
        description: 'Description of the feature to implement',
        required: true,
      },
      {
        name: 'existing_codebase',
        description: 'Context about existing code patterns, architecture, and conventions',
        required: false,
      },
    ],
    handler: async (args) => {
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `I need to implement a new Swift feature in my Xcode project.

## Feature Description
${args.feature_description || 'Not provided'}

## Existing Code Context
${args.existing_codebase || 'Standard SwiftUI + Swift project'}

Please provide:
1. The complete Swift implementation code
2. File structure (what files to create/modify)
3. Any model/ViewModel/View changes needed
4. Error handling approach
5. Testing considerations

Follow Swift best practices, use proper error handling, and match modern Swift conventions.`,
          },
        }],
      };
    },
  });

  server.registerPrompt({
    name: 'write_xctest',
    description: 'Given a class name and methods, generate comprehensive XCTest cases',
    arguments: [
      {
        name: 'class_name',
        description: 'The class/struct to write tests for',
        required: true,
      },
      {
        name: 'method_names',
        description: 'Comma-separated list of methods to test',
        required: true,
      },
      {
        name: 'class_content',
        description: 'The source code of the class being tested',
        required: true,
      },
    ],
    handler: async (args) => {
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `I need XCTest cases for a Swift class in my Xcode project.

## Class to Test
**Name:** ${args.class_name || 'Unknown'}
**Methods:** ${args.method_names || 'All methods'}

## Source Code
\`\`\`swift
${args.class_content || 'Not provided'}
\`\`\`

Please generate comprehensive XCTest cases:
1. Test initialization and setup
2. Test each method with normal inputs
3. Test edge cases (empty, nil, boundary values)
4. Test error conditions
5. Follow Given-When-Then pattern in comments
6. Use proper setUp/tearDown
7. Test async operations with XCTestExpectation if needed

Generate complete, compilable test code.`,
          },
        }],
      };
    },
  });

  server.registerPrompt({
    name: 'review_swift_code',
    description: 'Review Swift code for best practices, performance, and potential issues',
    arguments: [
      {
        name: 'file_content',
        description: 'The Swift source code to review',
        required: true,
      },
      {
        name: 'file_path',
        description: 'The file path for context',
        required: false,
      },
    ],
    handler: async (args) => {
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Please review this Swift code for best practices, performance, and potential issues.

## File: ${args.file_path || 'Unknown'}
\`\`\`swift
${args.file_content || 'Not provided'}
\`\`\`

Please review for:
1. Swift best practices and conventions
2. Performance concerns (retain cycles, unnecessary copies, etc.)
3. Memory management issues
4. Thread safety / actor isolation
5. Error handling completeness
6. Optional handling safety
7. Code organization and readability
8. API design improvements
9. Testing considerations
10. Specific improvement suggestions with code examples

Focus on actionable, specific feedback with code examples.`,
          },
        }],
      };
    },
  });
}
