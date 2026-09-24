package com.phren.android.features

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.phren.android.StoreSkill
import com.phren.android.design.BackCloses
import com.phren.android.design.FormDivider
import com.phren.android.design.FormRow
import com.phren.android.design.FormRows
import com.phren.android.design.FormSection
import com.phren.android.design.LocalDismiss
import com.phren.android.design.LocalNavigator
import com.phren.android.design.PhrenActionSheet
import com.phren.android.design.PhrenControlAction
import com.phren.android.design.PhrenDialog
import com.phren.android.design.PhrenEmptyState
import com.phren.android.design.PhrenFieldSurface
import com.phren.android.design.PhrenForm
import com.phren.android.design.PhrenNavBar
import com.phren.android.design.PhrenNavScreen
import com.phren.android.design.PhrenOption
import com.phren.android.design.PhrenSearchField
import com.phren.android.design.PhrenSheet
import com.phren.android.design.PhrenSingleSelect
import com.phren.android.design.PhrenSingleSelectSheet
import com.phren.android.design.PhrenSwitchRow
import com.phren.android.design.PhrenTextField
import com.phren.android.design.PhrenTheme
import com.phren.android.design.PhrenType
import com.phren.android.design.PhrenType.mono
import com.phren.android.design.SF
import com.phren.android.design.ToolbarItem
import com.phren.android.design.phrenIdentifier
import com.phren.android.design.plainClickable
import com.phren.kit.LocalStore
import com.phren.kit.Skill
import com.phren.kit.SkillFile
import kotlinx.coroutines.launch

/** SkillsView.swift: global and project skills, grouped by scope. */
@Composable
fun SkillsView(project: String? = null, storeId: String? = null, returnToProject: (() -> Unit)? = null) {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    var query by remember { mutableStateOf("") }
    var creating by remember { mutableStateOf(false) }
    val search = query.trim()
    val available = storeId?.let { id -> model.skills(id).map { StoreSkill(id, model.storeName(id), it) } } ?: model.mergedSkills
    val skills = available.filter { e ->
        (storeId == null || e.storeId == storeId) &&
            (project == null || e.skill.scope == Skill.Scope.Global || e.skill.scope.source == project) &&
            (search.isEmpty() || listOf(e.skill.name, e.skill.content, e.storeName, e.skill.scope.source).any { it.contains(search, ignoreCase = true) })
    }
    val scopes = skills.map { it.skill.scope.source }.toSortedSet(compareBy<String> { it != "global" }.thenBy { it }).toList()
    val canCreate = model.storeDescriptors.any { it.canPush && (storeId == null || it.id == storeId) && (storeId != null || model.storeFilter == null || it.id == model.storeFilter) }
    fun open(entry: StoreSkill) = navigator.push("skill:${entry.id}") { SkillEditorView(entry, returnToProject) }

    PhrenNavScreen(
        "Skills", onBack = navigator::pop,
        trailing = buildList {
            if (returnToProject != null) add(ToolbarItem(icon = SF("xmark"), label = "Back to project", identifier = "skills-return-to-project", onClick = returnToProject))
            if (canCreate) add(ToolbarItem(icon = SF("plus"), label = "New skill", identifier = "skills-new") { creating = true })
        },
    ) {
        LiveStatusBar()
        PhrenSearchField(query, { query = it }, placeholder = "Search skills", identifier = "skills-search", modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp).fillMaxWidth())
        Box(Modifier.weight(1f)) {
            Refreshable {
                PhrenForm {
                    for (scope in scopes) {
                        val rows = skills.filter { it.skill.scope.source == scope }.sortedWith(compareBy({ it.skill.name }, { it.storeId }))
                        FormSection(if (scope == "global") "Global skills" else scope) {
                            FormRows(rows.size, inset = 16.dp) { i ->
                                val entry = rows[i]
                                SkillRow(entry, project) { open(entry) }
                            }
                        }
                    }
                }
            }
            if (skills.isEmpty()) PhrenEmptyState(
                if (query.isEmpty()) "No skills yet" else "No matching skills",
                if (query.isEmpty()) "Create reusable instructions for your agents." else "Try another name, project, or phrase.",
                Modifier.fillMaxSize(),
            )
        }
    }
    if (creating) PhrenSheet({ creating = false }) {
        NewSkillSheet(project, storeId) { created -> open(created) }
    }
}

@Composable
private fun SkillRow(entry: StoreSkill, project: String?, onClick: () -> Unit) {
    val model = LocalModel.current
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).plainClickable(onClick = onClick).phrenIdentifier("skill:${entry.storeId}:${entry.skill.path}").padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(entry.skill.title ?: entry.skill.name, style = PhrenType.headline, color = PhrenTheme.text)
            entry.skill.summary?.takeIf { it.isNotEmpty() }?.let { Text(it, style = PhrenType.subheadline, color = PhrenTheme.textSecondary, maxLines = 2) }
            val disabled = runCatching { model.skillPreferences(entry.storeId).explicitSetting(entry.skill.scope.source, entry.skill.name) == false }.getOrDefault(false)
            val warnings = SkillFile.frontmatterWarnings(entry.skill.content).isNotEmpty()
            val chips = model.hasMultipleStores || !model.canPush(entry.storeId) || disabled || (project != null && entry.skill.scope == Skill.Scope.Global) || warnings
            if (chips) Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                if (model.hasMultipleStores) TagChip(entry.storeName, PhrenTheme.ChipRole.STORE)
                if (!model.canPush(entry.storeId)) TagChip("Read-only", PhrenTheme.ChipRole.STATUS)
                if (disabled) TagChip("Disabled", PhrenTheme.ChipRole.STATUS)
                if (project != null && entry.skill.scope == Skill.Scope.Global) TagChip("Global", PhrenTheme.ChipRole.SCOPE)
                if (warnings) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Icon(SF("exclamationmark.triangle"), null, tint = Color(0xFFFF9F0A), modifier = Modifier.size(12.dp))
                    Text("Needs details", style = PhrenType.caption, color = Color(0xFFFF9F0A))
                }
            }
        }
        Icon(SF("chevron.right"), null, tint = PhrenTheme.textDim, modifier = Modifier.size(15.dp))
    }
}


@Composable
fun SkillEditorView(entry: StoreSkill, returnToProject: (() -> Unit)? = null) {
    val model = LocalModel.current
    val navigator = LocalNavigator.current
    val context = LocalContext.current
    var draft by remember { mutableStateOf<DocumentDraft?>(null) }
    var deleting by remember { mutableStateOf(false) }
    var moving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var showingMore by remember { mutableStateOf(false) }
    val current = model.skills(entry.storeId).firstOrNull { it.path == entry.skill.path }?.let { StoreSkill(entry.storeId, entry.storeName, it) }
    val canPush = model.canPush(entry.storeId)

    fun toggle(skill: StoreSkill, enabled: Boolean) {
        busy = true
        model.scope.launch {
            try { model.setSkillEnabled(skill, enabled) } catch (e: Exception) { error = e.message }
            busy = false
        }
    }

    PhrenNavScreen(
        entry.skill.name, onBack = navigator::pop,
        trailing = buildList {
            if (returnToProject != null) add(ToolbarItem(icon = SF("xmark"), label = "Back to project", identifier = "skills-return-to-project", onClick = returnToProject))
            if (current != null && canPush) {
                add(ToolbarItem(text = "Edit", label = "Edit", enabled = !busy, identifier = "skill-edit") { draft = DocumentDraft(current.skill.path, current.skill.content) })
                add(ToolbarItem(icon = SF("ellipsis"), label = "More", enabled = !busy, identifier = "skill-more") { showingMore = true })
            }
        },
    ) {
        if (current == null) {
            PhrenEmptyState("Skill removed", "This skill is no longer in the store.", Modifier.fillMaxSize())
            return@PhrenNavScreen
        }
        PhrenForm {
            FormSection {
                FormRow("Scope", value = current.skill.scope.source, chevron = false)
                FormDivider(16.dp)
                FormRow("Store", value = current.storeName, chevron = false)
                if (!canPush) { FormDivider(16.dp); FormRow("Read-only store", icon = SF("lock"), chevron = false) }
                if (current.skill.format == Skill.Format.FOLDER) {
                    FormDivider(16.dp)
                    Text("This skill includes a folder. Editing changes its instructions; supporting files stay in the store.",
                        style = PhrenType.caption, color = PhrenTheme.textSecondary, modifier = Modifier.padding(16.dp))
                }
            }
            FormSection("Instructions") {
                Box(Modifier.padding(vertical = 12.dp)) { DocumentContentView(current.skill.path, current.skill.content, embedded = true, modifier = Modifier.padding(horizontal = 4.dp)) }
            }
            val scope = current.skill.scope.source
            FormSection("Availability", footer = if (current.skill.scope == Skill.Scope.Global)
                "Applies to this global skill in all projects. Linked computers apply the choice after syncing with an updated phren CLI."
            else "Applies to this project's skill. Linked computers apply the choice after syncing with an updated phren CLI.") {
                val preferences = runCatching { model.skillPreferences(entry.storeId) }.getOrNull()
                if (preferences == null) {
                    Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(SF("exclamationmark.triangle"), null, tint = Color(0xFFFF9F0A), modifier = Modifier.size(16.dp))
                        Text("Skill settings couldn't be read. Refresh or update phren before changing them.", style = PhrenType.callout, color = Color(0xFFFF9F0A))
                    }
                } else {
                    val enabled = preferences.explicitSetting(scope, current.skill.name)
                    if (enabled != null) {
                        Box(Modifier.padding(horizontal = 16.dp)) {
                            PhrenSwitchRow("Enabled for agents", enabled, { toggle(current, it) }, enabled = !busy && canPush, modifier = Modifier.phrenIdentifier("skill-enabled"))
                        }
                    } else {
                        FormRow("Availability", value = "Computer settings", chevron = false)
                        Text("No synced choice yet. A computer may have a different local setting.", style = PhrenType.caption, color = PhrenTheme.textSecondary,
                            modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 10.dp))
                        if (canPush) {
                            FormDivider(16.dp)
                            FormRow("Enable on linked computers", titleColor = PhrenTheme.navigation, chevron = false, enabled = !busy) { toggle(current, true) }
                            FormDivider(16.dp)
                            FormRow("Disable on linked computers", titleColor = PhrenTheme.navigation, chevron = false, enabled = !busy) { toggle(current, false) }
                        }
                    }
                }
            }
            FormSection {
                Text(current.skill.path, style = PhrenType.caption.mono(), color = PhrenTheme.textSecondary, modifier = Modifier.padding(16.dp))
                FormDivider(16.dp)
                FormRow("Share skill", icon = SF("square.and.arrow.up"), titleColor = PhrenTheme.navigation, chevron = false) {
                    context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, current.skill.content), null))
                }
            }
        }
    }
    if (showingMore && current != null) PhrenActionSheet(entry.skill.name, listOf(
        PhrenControlAction("move", "Move to…", SF("folder")) { moving = true },
        PhrenControlAction("delete", "Delete skill", SF("trash"), role = PhrenControlAction.Role.DESTRUCTIVE) { deleting = true },
    ), identifier = "skill-more-sheet") { showingMore = false }
    draft?.let { d -> PhrenSheet({ draft = null }) { DocumentEditorSheet("Edit skill", entry.storeId, d) } }
    if (moving && current != null) PhrenSheet({ moving = false }) { MoveSkillSheet(current) { navigator.pop() } }
    if (deleting) PhrenDialog("Delete ${entry.skill.name}?",
        "The skill's instructions will be removed from ${entry.storeName} on sync." + if (entry.skill.format == Skill.Format.FOLDER) " Supporting files will remain in its folder." else "",
        listOf(
            PhrenControlAction("delete", "Delete skill", role = PhrenControlAction.Role.DESTRUCTIVE) {
                current?.let { c ->
                    busy = true
                    model.scope.launch {
                        try { model.deleteSkill(c); navigator.pop() } catch (e: Exception) { error = e.message }
                        busy = false
                    }
                }
            },
            PhrenControlAction("cancel", "Cancel", role = PhrenControlAction.Role.CANCEL) {},
        ), identifier = "skill-delete-dialog") { deleting = false }
    error?.let { message ->
        PhrenDialog("Couldn't update skill", message, listOf(PhrenControlAction("ok", "OK", role = PhrenControlAction.Role.CANCEL) {}),
            identifier = "skill-update-error-dialog") { error = null }
    }
}

@Composable
private fun MoveSkillSheet(entry: StoreSkill, onMoved: () -> Unit) {
    val model = LocalModel.current
    val dismiss = LocalDismiss.current ?: {}
    val destinations = (listOf("global") + model.writableProjects.filter { it.storeId == entry.storeId }.map { it.project.name }.sorted())
        .filter { it != entry.skill.scope.source }
    var scope by remember { mutableStateOf(destinations.firstOrNull() ?: "") }
    var error by remember { mutableStateOf<String?>(null) }
    var moving by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf(false) }
    val occupied = model.skills(entry.storeId).any { it.scope.source == scope && it.name.equals(entry.skill.name, ignoreCase = true) }
    val valid = scope in destinations && !occupied
    val options = destinations.map { PhrenOption(id = it, value = it, title = if (it == "global") "Global · all projects" else it) }
    BackCloses(moving) {}
    Column(Modifier.fillMaxSize()) {
        PhrenNavBar("Move ${entry.skill.name}", inSheet = true,
            leading = listOf(ToolbarItem(text = "Cancel", label = "Cancel", enabled = !moving, onClick = dismiss)),
            trailing = listOf(ToolbarItem(text = if (moving) "Moving…" else "Move", label = "Move", bold = true, enabled = valid && !moving, identifier = "skill-move-confirm") {
                moving = true
                model.scope.launch {
                    try { model.moveSkill(entry, scope); dismiss(); onMoved() } catch (e: Exception) { error = e.message }
                    moving = false
                }
            }))
        if (destinations.isEmpty()) {
            PhrenEmptyState("Nowhere to move", "This store has no other project to hold the skill.", Modifier.fillMaxSize())
        } else PhrenForm {
            FormSection("Destination", footer = "Moves the skill's instructions out of ${entry.skill.scope.source} on sync." +
                if (entry.skill.format == Skill.Format.FOLDER) " Supporting files in its folder stay behind." else "") {
                Box(Modifier.padding(16.dp)) { PhrenSingleSelect(options, scope, placeholder = "Move to", identifier = "skill-move-destination", enabled = !moving) { picking = true } }
                if (occupied) Text("A skill named ${entry.skill.name} already exists there.", style = PhrenType.caption, color = Color(0xFFFF453A),
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp))
            }
        }
    }
    if (picking) PhrenSingleSelectSheet("Move to", options, scope, { scope = it }, rowPrefix = "skill-move-destination") { picking = false }
    error?.let { PhrenDialog("Couldn't move skill", it, listOf(PhrenControlAction("ok", "OK", role = PhrenControlAction.Role.CANCEL) {}), identifier = "skill-move-error-dialog") { error = null } }
}

@Composable
private fun NewSkillSheet(defaultProject: String?, defaultStoreId: String?, onCreate: (StoreSkill) -> Unit) {
    val model = LocalModel.current
    val dismiss = LocalDismiss.current ?: {}
    val stores = model.storeDescriptors.filter { it.canPush && (defaultStoreId == null || it.id == defaultStoreId) && (defaultStoreId != null || model.storeFilter == null || it.id == model.storeFilter) }
    var name by remember { mutableStateOf("") }
    var summary by remember { mutableStateOf("") }
    var instructions by remember { mutableStateOf("") }
    var storeId by remember { mutableStateOf(stores.firstOrNull()?.id ?: "") }
    val projects = model.writableProjects.filter { it.storeId == storeId }.map { it.project.name }.sorted()
    var scope by remember { mutableStateOf(defaultProject?.takeIf { it in projects } ?: "global") }
    var error by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var confirmingDiscard by remember { mutableStateOf(false) }
    var pickingStore by remember { mutableStateOf(false) }
    var pickingScope by remember { mutableStateOf(false) }
    LaunchedEffect(storeId) { if (scope != "global" && scope !in projects) scope = "global" }
    val trimmed = name.trim()
    val path = "$scope/skills/$trimmed.md"
    val nameError = when {
        trimmed.isEmpty() -> null
        !LocalStore.isSkillPath(path) -> "Start with a letter or number; use letters, numbers, dots, dashes, or underscores."
        model.skills(storeId).any { it.scope.source == scope && it.name.equals(trimmed, ignoreCase = true) } -> "A skill with that name already exists in this scope."
        else -> null
    }
    val valid = trimmed.isNotEmpty() && nameError == null && stores.any { it.id == storeId } && (scope == "global" || scope in projects) &&
        summary.isNotBlank() && instructions.isNotBlank()
    val dirty = name.isNotEmpty() || summary.isNotEmpty() || instructions.isNotEmpty()
    val storeOptions = stores.map { PhrenOption(id = it.id, value = it.id, title = it.displayName) }
    val scopeOptions = listOf(PhrenOption(id = "global", value = "global", title = "Global · all projects")) + projects.map { PhrenOption(id = it, value = it, title = it) }

    BackCloses(true) { if (dirty) confirmingDiscard = true else dismiss() }
    Column(Modifier.fillMaxSize()) {
        PhrenNavBar("New skill", inSheet = true,
            leading = listOf(ToolbarItem(text = "Cancel", label = "Cancel", enabled = !saving) { if (dirty) confirmingDiscard = true else dismiss() }),
            trailing = listOf(ToolbarItem(text = if (saving) "Creating…" else "Create", label = "Create", bold = true, enabled = valid && !saving, identifier = "new-skill-create") {
                saving = true
                model.scope.launch {
                    try {
                        val content = SkillFile.template(trimmed, summary, instructions)
                        model.saveDocument(path, content, null, storeId)
                        Skill.parse(path, content)?.let { onCreate(StoreSkill(storeId, model.storeName(storeId), it)) }
                        dismiss()
                    } catch (e: Exception) { error = e.message }
                    saving = false
                }
            }))
        PhrenForm {
            FormSection("Skill") {
                Box(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    PhrenTextField("skill-name", name, { name = it }, identifier = "new-skill-name", surface = PhrenFieldSurface.BARE, enabled = !saving)
                }
                nameError?.let { Text(it, style = PhrenType.caption, color = Color(0xFFFF453A), modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp)) }
                FormDivider(16.dp)
                Box(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    PhrenTextField("When should an agent use this skill?", summary, { summary = it }, identifier = "new-skill-summary", multiline = true, surface = PhrenFieldSurface.BARE, enabled = !saving)
                }
            }
            FormSection("Location") {
                if (stores.size > 1) Box(Modifier.padding(16.dp)) { PhrenSingleSelect(storeOptions, storeId, placeholder = "Store", identifier = "new-skill-store") { pickingStore = true } }
                else stores.firstOrNull()?.let { FormRow("Store", value = it.displayName, chevron = false) }
                FormDivider(16.dp)
                Box(Modifier.padding(16.dp)) { PhrenSingleSelect(scopeOptions, scope, placeholder = "Scope", identifier = "new-skill-scope") { pickingScope = true } }
            }
            FormSection("Instructions") {
                BasicTextField(instructions, { instructions = it }, enabled = !saving,
                    textStyle = PhrenType.body.copy(color = PhrenTheme.text), cursorBrush = SolidColor(PhrenTheme.cyan),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 200.dp).padding(16.dp).phrenIdentifier("new-skill-instructions"))
            }
        }
    }
    if (pickingStore) PhrenSingleSelectSheet("Store", storeOptions, storeId, { storeId = it }, rowPrefix = "new-skill-store") { pickingStore = false }
    if (pickingScope) PhrenSingleSelectSheet("Scope", scopeOptions, scope, { scope = it }, rowPrefix = "new-skill-scope") { pickingScope = false }
    if (confirmingDiscard) PhrenDialog("Discard this skill?", "The name, summary, and instructions you entered will be lost.", listOf(
        PhrenControlAction("discard", "Discard", role = PhrenControlAction.Role.DESTRUCTIVE) { dismiss() },
        PhrenControlAction("keep", "Keep editing", role = PhrenControlAction.Role.CANCEL) {},
    ), identifier = "skill-discard-dialog") { confirmingDiscard = false }
    error?.let { PhrenDialog("Couldn't create skill", it, listOf(PhrenControlAction("ok", "OK", role = PhrenControlAction.Role.CANCEL) {}), identifier = "skill-create-error-dialog") { error = null } }
}

@Suppress("unused") private val keepWeight = FontWeight.Normal
