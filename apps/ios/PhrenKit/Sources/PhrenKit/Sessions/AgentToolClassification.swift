import Foundation

/// Shared routing for provider tool names. Rendering uses the same decision
/// tested against captured OpenCode calls, before considering generic rows.
public enum AgentToolClassification: String, Equatable, Sendable {
    case phren, todos, patch, agent, web, skill, generic

    public static func kind(name: String?, input: String = "{}") -> Self {
        if PhrenToolPresentation.recognizes(name) { return .phren }
        if AgentTodoPresentation.recognizes(name) { return .todos }
        if AgentSubagentPresentation.recognizes(name) { return .agent }
        let tool = AgentToolCardJSON.tool(name).lowercased()
        if ["edit", "write", "multiedit", "apply_patch"].contains(tool) { return .patch }
        if WebToolPresentation.recognizes(name) { return .web }
        if SkillCallPresentation.recognizes(name) { return .skill }
        return .generic
    }
}
