import * as vscode from "vscode";
import type { PhrenCategory, PhrenNode, SessionBucket, DateFilter } from "./tree-types";
import {
  categoryIconId,
  formatDateLabel,
  formatRelativeTime,
  formatSessionTimeLabel,
  taskIconId,
  themeIcon,
  truncate,
} from "./tree-utils";

export function buildTreeItem(element: PhrenNode, dateFilter: DateFilter | undefined): vscode.TreeItem {
  if (!element || !element.kind) {
    return new vscode.TreeItem("(unknown)", vscode.TreeItemCollapsibleState.None);
  }
  switch (element.kind) {
    case "rootSection": {
      const labels: Record<string, string> = { projects: "Projects", tasks: "Tasks", machines: "Machines", review: "Review Queue", skills: "Skills", hooks: "Hooks", graph: "Fragment Graph", manage: "Manage" };
      const icons: Record<string, string> = { projects: "hubot", tasks: "checklist", machines: "vm", review: "inbox", skills: "extensions", hooks: "plug", graph: "type-hierarchy", manage: "gear" };
      const label = labels[element.section] ?? element.section;

      if (element.section === "graph") {
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = themeIcon(icons[element.section]);
        item.id = `phren.root.${element.section}`;
        item.command = { command: "phren.showGraph", title: "Show Fragment Graph" };
        item.tooltip = "Open the Phren fragment graph visualization";
        return item;
      }

      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = element.description;
      item.iconPath = themeIcon(icons[element.section] ?? "symbol-misc");
      item.id = `phren.root.${element.section}`;
      return item;
    }
    case "project": {
      const item = new vscode.TreeItem(element.projectName, vscode.TreeItemCollapsibleState.Collapsed);
      const reviewBadge: string[] = [];
      if (element.conflictCount && element.conflictCount > 0) reviewBadge.push(`⚠ ${element.conflictCount}`);
      else if (element.reviewCount && element.reviewCount > 0) reviewBadge.push(`${element.reviewCount} review`);
      const badgeSuffix = reviewBadge.length > 0 ? `  ${reviewBadge.join(" · ")}` : "";
      if (element.active) {
        item.description = `★${badgeSuffix}${element.brief ? ` ${truncate(element.brief, 50)}` : ""}`;
        item.iconPath = themeIcon("star-full", "list.highlightForeground");
      } else {
        item.description = badgeSuffix || (element.brief ? truncate(element.brief, 72) : undefined);
        item.iconPath = element.conflictCount ? themeIcon("warning") : themeIcon("folder");
      }
      item.id = `phren.project.${element.projectName}`;
      item.contextValue = "phren.project";
      return item;
    }
    case "category": {
      const cat = element.category ?? "unknown";
      const categoryLabels: Record<string, string> = { findings: "Findings", truths: "Truths", sessions: "Sessions", task: "Tasks", queue: "Review Queue", hooks: "Hooks", reference: "Reference" };
      let categoryLabel = categoryLabels[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1);
      if (cat === "findings" && dateFilter) {
        categoryLabel += ` [${dateFilter.label}]`;
      }
      const item = new vscode.TreeItem(categoryLabel, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = themeIcon(categoryIconId(cat as PhrenCategory));
      item.id = `phren.category.${element.projectName}.${cat}`;
      if (cat === "findings") {
        item.contextValue = "phren.category.findings";
      }
      return item;
    }
    case "findingDateGroup": {
      const label = formatDateLabel(element.date);
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${element.count}`;
      item.iconPath = themeIcon("calendar");
      item.id = `phren.findingDateGroup.${element.projectName}.${element.date}`;
      return item;
    }
    case "sessionDateGroup": {
      const label = formatDateLabel(element.date);
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${element.count}`;
      item.iconPath = themeIcon("calendar");
      item.id = `phren.sessionDateGroup.${element.projectName}.${element.date}`;
      return item;
    }
    case "finding": {
      const item = new vscode.TreeItem(truncate(element.text, 120), vscode.TreeItemCollapsibleState.None);
      const tooltipLines = [element.text];
      let iconId = "lightbulb";
      if (element.supersededBy) {
        iconId = "lightbulb-autofix";
        tooltipLines.push(`Superseded by: "${element.supersededBy}"`);
      } else if (element.contradicts?.length) {
        iconId = "warning";
        tooltipLines.push(`Contradicts: "${element.contradicts[0]}"`);
      } else if (element.potentialDuplicates?.length) {
        iconId = "issue-opened";
        tooltipLines.push(`Potential duplicate of: "${element.potentialDuplicates[0]}"`);
        if (element.potentialDuplicates.length > 1) {
          tooltipLines.push(`(and ${element.potentialDuplicates.length - 1} more)`);
        }
      }
      if (element.supersedes) {
        tooltipLines.push(`Supersedes: "${element.supersedes}"`);
      }
      item.tooltip = tooltipLines.join("\n");
      item.iconPath = themeIcon(iconId);
      item.id = `phren.finding.${element.projectName}.${element.id}`;
      item.contextValue = "phren.finding";
      if (element.supersededBy) {
        item.description = "(superseded)";
      } else if (element.contradicts?.length) {
        item.description = "(conflict)";
      } else if (element.potentialDuplicates?.length) {
        item.description = "(possible duplicate)";
      } else if (element.date) {
        item.description = formatRelativeTime(element.date);
      }
      item.command = {
        command: "phren.openFinding",
        title: "Open Finding",
        arguments: [element],
      };
      return item;
    }
    case "globalTaskSectionGroup": {
      const globalSectionIcons: Record<string, string> = { Pinned: "pinned", Active: "play", Queue: "clock", Done: "check" };
      const item = new vscode.TreeItem(element.section, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${element.count}`;
      item.iconPath = themeIcon(globalSectionIcons[element.section] ?? "list-flat");
      item.id = `phren.globalTaskSectionGroup.${element.section}`;
      return item;
    }
    case "taskSectionGroup": {
      const sectionIcons: Record<string, string> = { Active: "play", Queue: "clock", Done: "check" };
      const item = new vscode.TreeItem(element.section, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${element.count}`;
      item.iconPath = themeIcon(sectionIcons[element.section] ?? "list-flat");
      item.id = `phren.taskSectionGroup.${element.projectName}.${element.section}`;
      return item;
    }
    case "task": {
      const item = new vscode.TreeItem(truncate(element.line, 120), vscode.TreeItemCollapsibleState.None);
      item.description = element.projectName;
      item.tooltip = `[${element.projectName}] ${element.section} (${element.id})\n${element.line}`;
      item.iconPath = themeIcon(taskIconId(element));
      item.id = `phren.task.${element.projectName}.${element.id}`;
      item.contextValue = element.section !== "Done" ? "phren.task.active" : "phren.task.done";
      item.command = {
        command: "phren.openTask",
        title: "Open Task",
        arguments: [element],
      };
      return item;
    }
    case "reviewProjectGroup": {
      const total = element.reviewCount + element.conflictCount;
      const item = new vscode.TreeItem(element.projectName, vscode.TreeItemCollapsibleState.Collapsed);
      const parts: string[] = [];
      if (element.conflictCount > 0) parts.push(`⚠ ${element.conflictCount}`);
      if (element.reviewCount > 0) parts.push(`${element.reviewCount} review`);
      item.description = parts.length > 0 ? parts.join(" · ") : `${total}`;
      item.iconPath = element.conflictCount > 0 ? themeIcon("warning") : themeIcon("inbox");
      item.id = `phren.reviewProjectGroup.${element.projectName}`;
      return item;
    }
    case "queueSectionGroup": {
      const queueIcons: Record<string, string> = { Review: "inbox", Stale: "history", Conflicts: "warning" };
      const item = new vscode.TreeItem(element.section, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${element.count}`;
      item.iconPath = themeIcon(queueIcons[element.section] ?? "list-flat");
      item.id = `phren.queueSectionGroup.${element.projectName}.${element.section}`;
      return item;
    }
    case "aggregateQueueSectionGroup": {
      const queueIcons: Record<string, string> = { Review: "inbox", Stale: "history", Conflicts: "warning" };
      const item = new vscode.TreeItem(element.section, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${element.count}`;
      item.iconPath = themeIcon(queueIcons[element.section] ?? "list-flat");
      item.id = `phren.aggregateQueueSectionGroup.${element.section}`;
      return item;
    }
    case "queueItem": {
      const item = new vscode.TreeItem(truncate(element.text, 120), vscode.TreeItemCollapsibleState.None);
      const confLabel = element.confidence !== undefined ? ` (${Math.round(element.confidence * 100)}%)` : "";
      item.tooltip = `${element.section} ${element.id}${confLabel}\n${element.date}\n${element.text}`;
      item.iconPath = themeIcon(element.risky ? "warning" : "mail");
      item.id = `phren.queueItem.${element.projectName}.${element.id}`;
      item.description = element.showProjectName ? element.projectName : undefined;
      item.contextValue = "phren.queue.item";
      item.command = {
        command: "phren.openQueueItem",
        title: "Open Queue Item",
        arguments: [element],
      };
      return item;
    }
    case "skillGroup": {
      const label = element.source.charAt(0).toUpperCase() + element.source.slice(1);
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = themeIcon(element.source === "global" ? "globe" : "folder");
      item.id = `phren.skillGroup.${element.source}`;
      return item;
    }
    case "skill": {
      const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
      item.description = element.enabled ? "enabled" : "disabled";
      item.tooltip = `${element.name} (${element.source})\n${element.enabled ? "Enabled" : "Disabled"}${element.path ? `\n${element.path}` : ""}`;
      item.iconPath = themeIcon(element.enabled ? "check" : "circle-slash");
      item.id = `phren.skill.${element.source}.${element.name}`;
      item.contextValue = element.enabled ? "phren.skill.enabled" : "phren.skill.disabled";
      item.command = {
        command: "phren.openSkill",
        title: "Open Skill",
        arguments: [element.name, element.source],
      };
      return item;
    }
    case "hook": {
      const item = new vscode.TreeItem(element.tool, vscode.TreeItemCollapsibleState.None);
      item.description = element.enabled ? "enabled" : "disabled";
      item.tooltip = `${element.tool}: ${element.enabled ? "hooks enabled" : "hooks disabled"}\nClick to toggle`;
      item.iconPath = themeIcon(element.enabled ? "check" : "circle-slash");
      item.id = `phren.hook.${element.tool}`;
      item.contextValue = "phren.hookItem";
      item.command = {
        command: "phren.toggleHook",
        title: "Toggle Hook",
        arguments: [element.tool, element.enabled],
      };
      return item;
    }
    case "customHook": {
      const item = new vscode.TreeItem(element.event, vscode.TreeItemCollapsibleState.None);
      const prefix = element.isWebhook ? "[webhook] " : "";
      item.description = `${prefix}${element.target}`;
      item.tooltip = `Custom hook: ${element.event}\n${prefix}${element.target}${element.timeout ? `\nTimeout: ${element.timeout}ms` : ""}`;
      item.iconPath = themeIcon("zap");
      item.id = `phren.customHook.${element.event}.${element.target.slice(0, 20)}`;
      item.contextValue = "phren.customHookItem";
      return item;
    }
    case "projectHookEvent": {
      const overrideLabel = element.configured === null ? "(inherit)" : element.configured ? "(override: on)" : "(override: off)";
      const item = new vscode.TreeItem(element.event, vscode.TreeItemCollapsibleState.None);
      item.description = `${element.enabled ? "enabled" : "disabled"} ${overrideLabel}`;
      item.tooltip = `${element.event}: ${element.enabled ? "enabled" : "disabled"}\n${element.configured === null ? "Inheriting from global" : `Per-project override: ${element.configured ? "enabled" : "disabled"}`}\nClick to toggle`;
      item.iconPath = themeIcon(element.enabled ? "check" : "circle-slash");
      item.id = `phren.projectHookEvent.${element.projectName}.${element.event}`;
      item.contextValue = "phren.projectHookEventItem";
      item.command = {
        command: "phren.toggleProjectHook",
        title: "Toggle Project Hook",
        arguments: [element],
      };
      return item;
    }
    case "hookError": {
      const item = new vscode.TreeItem(element.event, vscode.TreeItemCollapsibleState.None);
      const ts = element.timestamp.slice(0, 19).replace("T", " ");
      item.description = `${ts} - ${element.message.slice(0, 60)}`;
      item.tooltip = `${element.timestamp}\n${element.event}: ${element.message}`;
      item.iconPath = themeIcon("warning");
      item.id = `phren.hookError.${element.timestamp}`;
      item.contextValue = "phren.hookErrorItem";
      return item;
    }
    case "truth": {
      const item = new vscode.TreeItem(truncate(element.text, 120), vscode.TreeItemCollapsibleState.None);
      item.tooltip = element.text;
      item.iconPath = themeIcon("pin");
      item.id = `phren.truth.${element.projectName}.${element.text.slice(0, 40).replace(/\W/g, "_")}`;
      item.contextValue = "phren.truthItem";
      return item;
    }
    case "referenceFile": {
      const item = new vscode.TreeItem(element.fileName, vscode.TreeItemCollapsibleState.None);
      item.iconPath = themeIcon("file");
      item.id = `phren.reference.${element.projectName}.${element.fileName}`;
      item.command = {
        command: "phren.openProjectFile",
        title: "Open File",
        arguments: [element.projectName, `reference/${element.fileName}`],
      };
      return item;
    }
    case "session": {
      const item = new vscode.TreeItem(formatSessionTimeLabel(element.startedAt), vscode.TreeItemCollapsibleState.Collapsed);
      const descriptionParts = [`${element.durationMins ?? 0}m`];
      if (element.findingsAdded > 0) {
        descriptionParts.push(`${element.findingsAdded}f`);
      }
      if (element.status === "active") {
        descriptionParts.push("active");
      }
      if (element.summary) {
        descriptionParts.push(truncate(element.summary, 40));
      }
      item.description = descriptionParts.join(" · ");
      item.tooltip = [
        `Session ${element.sessionId.slice(0, 8)}`,
        `Project: ${element.projectName}`,
        `Started: ${element.startedAt}`,
        `Duration: ~${element.durationMins ?? 0} min`,
        `Findings added: ${element.findingsAdded}`,
        `Status: ${element.status}`,
        ...(element.summary ? [`Summary: ${element.summary}`] : []),
      ].join("\n");
      item.iconPath = themeIcon(element.status === "active" ? "play-circle" : "history");
      item.id = `phren.session.${element.sessionId}`;
      item.contextValue = "phren.session";
      return item;
    }
    case "sessionBucket": {
      const labels: Record<SessionBucket, string> = { findings: "Findings", tasks: "Tasks" };
      const icons: Record<SessionBucket, string> = { findings: "list-flat", tasks: "checklist" };
      const item = new vscode.TreeItem(labels[element.bucket], vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${element.count}`;
      item.iconPath = themeIcon(icons[element.bucket]);
      item.id = `phren.sessionBucket.${element.projectName}.${element.sessionId}.${element.bucket}`;
      return item;
    }
    case "projectGroup": {
      const groupLabels: Record<string, string> = { device: "This Device", other: "Other Machines" };
      const groupIcons: Record<string, string> = { device: "vm", other: "globe" };
      const item = new vscode.TreeItem(groupLabels[element.group] ?? element.group, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${element.count}`;
      item.iconPath = themeIcon(groupIcons[element.group] ?? "folder");
      item.id = `phren.projectGroup.${element.group}`;
      return item;
    }
    case "storeGroup": {
      const roleIcons: Record<string, string> = { primary: "home", team: "organization", readonly: "eye", "pull-only": "cloud-download" };
      const item = new vscode.TreeItem(element.storeName, vscode.TreeItemCollapsibleState.Collapsed);
      const descParts: string[] = [element.role];
      if (element.syncMode) descParts.push(element.syncMode);
      descParts.push(element.lastSync ? formatRelativeTime(element.lastSync) : "never synced");
      item.description = descParts.join(" \u00b7 ");
      item.iconPath = themeIcon(roleIcons[element.role] ?? "database");
      item.id = `phren.storeGroup.${element.storeName}`;
      item.tooltip = `Store: ${element.storeName}\nRole: ${element.role}\nSync: ${element.syncMode ?? "none"}\nLast sync: ${element.lastSync ?? "never"}`;
      return item;
    }
    case "manageItem": {
      const manageIcons: Record<string, string> = { health: "heart", profile: "vm", machine: "server", lastSync: "cloud", storeSync: "cloud" };
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.description = element.value;
      item.iconPath = themeIcon(manageIcons[element.item] ?? "info");
      item.id = element.item === "storeSync" ? `phren.manage.storeSync.${element.storeName}` : `phren.manage.${element.item}`;
      if (element.item === "health") {
        item.command = { command: "phren.doctor", title: "Run Doctor" };
        item.tooltip = "Click to run Phren Doctor";
      } else if (element.item === "machine") {
        item.command = { command: "phren.configureMachine", title: "Set Machine Alias" };
        item.tooltip = "Click to change this machine alias";
      } else if (element.item === "profile") {
        item.command = { command: "phren.switchProfile", title: "Configure Profile" };
        item.tooltip = "Click to change this machine's profile mapping";
      } else if (element.item === "lastSync") {
        item.command = { command: "phren.sync", title: "Sync Now" };
        item.tooltip = "Click to sync Phren";
      } else if (element.item === "storeSync") {
        item.command = { command: "phren.sync", title: "Sync Now" };
        item.tooltip = `Store: ${element.storeName}\nSync mode: ${element.syncMode ?? "none"}\nClick to sync`;
      }
      return item;
    }
    case "message": {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.description = element.description;
      item.iconPath = themeIcon(element.iconId ?? "info");
      return item;
    }
  }
}
