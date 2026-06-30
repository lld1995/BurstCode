/**
 * Test runner entry point.
 * Registers the vscode mock before importing tests that depend on vscode APIs.
 */
import './register-vscode-mock';
import './web.test';
import './video.test';
