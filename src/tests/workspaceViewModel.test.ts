import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import type { RuleProject, WorkspaceDocument } from '../models/ruleModel';
import type { CheckOperation } from '../services/ruleCheckService';
import { RuleWorkspaceViewModel } from '../viewmodels/workspaceViewModel';

class MemoryRepository {
  document: WorkspaceDocument | null = null;
  async load() { return this.document ? structuredClone(this.document) : null; }
  async save(document: WorkspaceDocument) { this.document = structuredClone(document); }
}

class FakeChecker {
  calls = 0;
  nextError: Error | null = null;
  cancelled = false;

  run(project: RuleProject): CheckOperation {
    this.calls += 1;
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      return { promise: Promise.reject(error), cancel: () => { this.cancelled = true; } };
    }
    return { promise: Promise.resolve(analyzeRules(project)), cancel: () => { this.cancelled = true; } };
  }
}

describe('RuleWorkspaceViewModel', () => {
  beforeEach(() => vi.useFakeTimers());

  it('initializes a usable demo, runs checks, persists edits, and recovers the workspace', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    expect(workspace.getSnapshot().project?.rules).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    const current = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...current, title: '已修改策略' }, '测试编辑', { recheck: false });
    await vi.advanceTimersByTimeAsync(250);
    await workspace.flushSave();
    expect(repository.document?.projects[0].title).toBe('已修改策略');

    const restored = new RuleWorkspaceViewModel(repository, checker);
    await restored.start();
    expect(restored.getSnapshot().project?.title).toBe('已修改策略');
    restored.dispose();
    workspace.dispose();
  });

  it('shows check errors and recovers on the next successful run', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    checker.nextError = new Error('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().phase).toBe('error');
    expect(workspace.getSnapshot().notice).toBe('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    expect(workspace.getSnapshot().analysis).not.toBeNull();
    workspace.dispose();
  });

  it('marks cancellation and blocks checks for invalid projects', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    const project = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...project, fields: project.fields.map((field) => field.id === 'cart-total' ? { ...field, min: 10, max: 0 } : field) });
    expect(workspace.getSnapshot().phase).toBe('validating');
    const callsBefore = checker.calls;
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('error');
    expect(checker.calls).toBe(callsBefore);
    workspace.dispose();
  });

  it('saves versions, freezes and resumes a version, and copies it into a new project', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    workspace.saveVersion();
    const savedVersion = workspace.getSnapshot().project?.versions[0];
    expect(savedVersion?.frozen).toBe(false);

    workspace.freezeCurrent();
    const frozen = workspace.getSnapshot().project;
    expect(frozen?.frozenVersionId).toBe(frozen?.versions[0].id);
    expect(workspace.commitProject({ ...(frozen as RuleProject), title: '不允许修改' })).toBe(false);

    workspace.restoreVersion(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().project?.frozenVersionId).toBeUndefined();
    workspace.copyVersionToProject(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(2);
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    workspace.dispose();
  });

  it('undoes recent edits and restores validation, sample evaluation and check state', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.getSnapshot().checkStatus).toBe('success');

    const base = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...base, rules: base.rules.map((rule, index) => index === 0 ? { ...rule, priority: 99 } : rule) }, '优先级已更新');
    const afterPriority = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...afterPriority, sampleInputs: { ...afterPriority.sampleInputs, 'cart-total': 10 } }, '样例已更新', { recheck: false, undoKey: 'sample:cart-total' });
    const afterSample = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...afterSample, fields: afterSample.fields.map((field) => field.id === 'cart-total' ? { ...field, min: 10, max: 0 } : field) }, '字段已更新');

    expect(workspace.getSnapshot().undoDepth).toBe(3);
    expect(workspace.getSnapshot().undoLabel).toBe('字段已更新');
    expect(workspace.getSnapshot().phase).toBe('validating');
    expect(workspace.getSnapshot().validationIssues.length).toBeGreaterThan(0);

    expect(workspace.undo()).toBe(true);
    expect(workspace.getSnapshot().notice).toBe('已撤销：字段已更新');
    expect(workspace.getSnapshot().validationIssues).toHaveLength(0);
    expect(workspace.getSnapshot().checkStatus).toBe('scheduled');
    expect(workspace.getSnapshot().analysis).toBeNull();

    expect(workspace.undo()).toBe(true);
    expect(workspace.getSnapshot().project?.sampleInputs['cart-total']).toBe(1200);
    expect(workspace.getSnapshot().sampleEvaluation?.matchedRules.length).toBeGreaterThan(0);

    expect(workspace.undo()).toBe(true);
    expect(workspace.getSnapshot().project?.rules[0].priority).toBe(30);
    expect(workspace.getSnapshot().undoDepth).toBe(0);
    expect(workspace.getSnapshot().undoLabel).toBeNull();
    expect(workspace.undo()).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    expect(workspace.getSnapshot().analysis).not.toBeNull();
    workspace.dispose();
  });

  it('coalesces rapid edits sharing an undo key into a single step', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    const original = workspace.getSnapshot().project?.title ?? '';
    workspace.commitProject({ ...(workspace.getSnapshot().project as RuleProject), title: '策略 A' }, '项目名称已更新', { recheck: false, undoKey: 'project:title' });
    workspace.commitProject({ ...(workspace.getSnapshot().project as RuleProject), title: '策略 AB' }, '项目名称已更新', { recheck: false, undoKey: 'project:title' });
    expect(workspace.getSnapshot().undoDepth).toBe(1);

    await vi.advanceTimersByTimeAsync(1500);
    workspace.commitProject({ ...(workspace.getSnapshot().project as RuleProject), title: '策略 ABC' }, '项目名称已更新', { recheck: false, undoKey: 'project:title' });
    expect(workspace.getSnapshot().undoDepth).toBe(2);

    workspace.undo();
    expect(workspace.getSnapshot().project?.title).toBe('策略 AB');
    workspace.undo();
    expect(workspace.getSnapshot().project?.title).toBe(original);
    workspace.dispose();
  });

  it('does not allow undo to cross freeze or version-restore boundaries', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    workspace.commitProject({ ...(workspace.getSnapshot().project as RuleProject), title: '冻结前修改' }, '编辑', { recheck: false });
    expect(workspace.getSnapshot().undoDepth).toBe(1);

    workspace.freezeCurrent();
    expect(workspace.getSnapshot().undoDepth).toBe(0);
    expect(workspace.undo()).toBe(false);
    expect(workspace.getSnapshot().project?.title).toBe('冻结前修改');

    const frozenVersionId = workspace.getSnapshot().project?.frozenVersionId ?? '';
    workspace.restoreVersion(frozenVersionId);
    workspace.commitProject({ ...(workspace.getSnapshot().project as RuleProject), title: '恢复后修改' }, '编辑', { recheck: false });
    expect(workspace.getSnapshot().undoDepth).toBe(1);

    workspace.restoreVersion(frozenVersionId);
    expect(workspace.getSnapshot().undoDepth).toBe(0);
    expect(workspace.undo()).toBe(false);
    workspace.dispose();
  });

  it('clears undo history when creating or switching projects', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    const first = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...first, title: '项目一修改' }, '编辑', { recheck: false });
    expect(workspace.getSnapshot().undoDepth).toBe(1);

    workspace.createProject();
    expect(workspace.getSnapshot().undoDepth).toBe(0);

    workspace.commitProject({ ...(workspace.getSnapshot().project as RuleProject), title: '项目二修改' }, '编辑', { recheck: false });
    expect(workspace.getSnapshot().undoDepth).toBe(1);

    workspace.switchProject(first.id);
    expect(workspace.getSnapshot().undoDepth).toBe(0);
    expect(workspace.undo()).toBe(false);
    expect(workspace.getSnapshot().project?.title).toBe('项目一修改');
    workspace.dispose();
  });
});
