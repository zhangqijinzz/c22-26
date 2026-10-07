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

  it('undoes recent edits and restores validation, sample evaluation, and check results', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.getSnapshot().canUndo).toBe(false);
    const before = workspace.getSnapshot().project as RuleProject;
    const evaluationBefore = workspace.getSnapshot().sampleEvaluation;

    // priority adjustment is undoable
    const rule = before.rules[0];
    workspace.commitProject({ ...before, rules: before.rules.map((item) => item.id === rule.id ? { ...item, priority: 999 } : item) }, '优先级已更新', { undoKey: `rule:${rule.id}:priority` });
    expect(workspace.getSnapshot().canUndo).toBe(true);
    workspace.undo();
    expect(workspace.getSnapshot().project?.rules[0].priority).toBe(rule.priority);

    // sample input edits are undoable and the evaluation returns to the prior state
    const current = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...current, sampleInputs: { ...current.sampleInputs, 'member-level': '普通会员', 'coupon-active': false } }, '样例已更新', { recheck: false, undoKey: 'sample:member-level' });
    expect(workspace.getSnapshot().sampleEvaluation?.winner?.id).not.toBe(evaluationBefore?.winner?.id);
    workspace.undo();
    expect(workspace.getSnapshot().project?.sampleInputs).toEqual(before.sampleInputs);
    expect(workspace.getSnapshot().sampleEvaluation?.winner?.id).toBe(evaluationBefore?.winner?.id);

    // invalid field edits surface validation issues; undo clears them and reschedules the check
    const valid = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...valid, fields: valid.fields.map((field) => field.id === 'cart-total' ? { ...field, min: 10, max: 0 } : field) });
    expect(workspace.getSnapshot().phase).toBe('validating');
    workspace.undo();
    expect(workspace.getSnapshot().validationIssues).toHaveLength(0);
    expect(workspace.getSnapshot().checkStatus).toBe('scheduled');
    await vi.advanceTimersByTimeAsync(200);
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    expect(workspace.getSnapshot().analysis).not.toBeNull();
    workspace.dispose();
  });

  it('coalesces rapid same-target edits into a single undo step', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    const before = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...before, title: '策略' }, '编辑', { recheck: false, undoKey: 'project:title' });
    workspace.commitProject({ ...workspace.getSnapshot().project as RuleProject, title: '策略草稿' }, '编辑', { recheck: false, undoKey: 'project:title' });
    workspace.undo();
    expect(workspace.getSnapshot().project?.title).toBe(before.title);
    expect(workspace.getSnapshot().canUndo).toBe(false);
    workspace.undo();
    expect(workspace.getSnapshot().project?.title).toBe(before.title);
    workspace.dispose();
  });

  it('does not undo across freeze, restore, or project switch boundaries', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    const before = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...before, title: '冻结前修改' }, '编辑', { recheck: false });
    expect(workspace.getSnapshot().canUndo).toBe(true);

    workspace.freezeCurrent();
    expect(workspace.getSnapshot().canUndo).toBe(false);
    workspace.undo();
    expect(workspace.getSnapshot().project?.title).toBe('冻结前修改');

    const frozenVersionId = workspace.getSnapshot().project?.frozenVersionId ?? '';
    workspace.restoreVersion(frozenVersionId);
    workspace.commitProject({ ...workspace.getSnapshot().project as RuleProject, title: '恢复后修改' }, '编辑', { recheck: false });
    workspace.restoreVersion(frozenVersionId);
    expect(workspace.getSnapshot().canUndo).toBe(false);
    workspace.undo();
    expect(workspace.getSnapshot().project?.title).toBe('恢复后修改');

    workspace.commitProject({ ...workspace.getSnapshot().project as RuleProject, title: '切换前修改' }, '编辑', { recheck: false });
    workspace.createProject();
    expect(workspace.getSnapshot().canUndo).toBe(false);
    workspace.switchProject(before.id);
    expect(workspace.getSnapshot().canUndo).toBe(false);
    workspace.undo();
    expect(workspace.getSnapshot().project?.title).toBe('切换前修改');
    workspace.dispose();
  });
});
