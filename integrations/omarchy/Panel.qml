import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// phren in the bar. One icon, one panel: what the store holds per project,
// what phren just recalled, and a way into the shell, the graph, or the web
// viewer without a terminal open. Strictly a display over the store's own
// files; bin/phren-omarchy-status reads them, bin/phren-omarchy-launch opens
// things. Modelled on the first-party Agents widget.
Panel {
  id: root
  moduleName: "phren"
  ipcTarget: "phren"
  manageIpc: false

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color accent: Color.accent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property string pluginDir: Qt.resolvedUrl(".").toString().replace(/^file:\/\//, "")

  readonly property int refreshSec: Math.max(10, Number(root.setting("refreshIntervalSec", 30)))
  readonly property int webPort: Number(root.setting("webPort", 3499))

  property var status: ({ ok: false, projects: [], recalls: [], totals: { projects: 0, findings: 0, tasks: 0 }, live: false, store: "", version: "" })
  property double nowMs: Date.now()
  property bool cursorActive: false
  property int cursor: 0
  readonly property var actions: ["shell", "graph", "web"]

  function launch(what) {
    if (root.bar) root.bar.run(root.pluginDir + "bin/phren-omarchy-launch " + what + " " + root.webPort)
    root.close()
  }

  function refreshNow() {
    if (!statusProcess.running) statusProcess.running = true
  }

  function applyStatus(text) {
    try {
      var parsed = JSON.parse(String(text || "").trim())
      if (parsed && typeof parsed === "object") root.status = parsed
    } catch (e) {
      // A half-written log line or a store mid-sync: keep what we had.
    }
  }

  function ago(seconds) {
    var s = Math.max(0, Math.floor(Number(seconds) || 0))
    if (s < 60) return s + "s"
    if (s < 3600) return Math.floor(s / 60) + "m"
    if (s < 86400) return Math.floor(s / 3600) + "h"
    return Math.floor(s / 86400) + "d"
  }

  function agoIso(iso) {
    var ms = new Date(String(iso || "")).getTime()
    if (!isFinite(ms)) return ""
    return ago((root.nowMs - ms) / 1000)
  }

  function summary() {
    var t = root.status.totals || {}
    if (!root.status.ok) return "no store at " + (root.status.store || "~/.phren")
    var parts = [(t.projects || 0) + " projects", (t.findings || 0) + " findings"]
    if ((t.tasks || 0) > 0) parts.push(t.tasks + " open tasks")
    return parts.join(" · ")
  }

  visible: true
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: if (opened) {
    cursorActive = false
    nowMs = Date.now()
    refreshNow()
    if (panelFlick) panelFlick.contentY = 0
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  Process {
    id: statusProcess
    running: false
    command: [root.pluginDir + "bin/phren-omarchy-status"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyStatus(text)
    }
  }

  // The store changes when agents write to it, not on a schedule; polling a
  // few files every half minute is the cheap way to notice without a watcher.
  Timer {
    interval: root.refreshSec * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refreshNow()
  }

  Timer {
    interval: 15000
    running: root.opened
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { root.refreshNow(); return "ok" }
    function shell(): string { root.launch("shell"); return "ok" }
    function graph(): string { root.launch("graph"); return "ok" }
    function web(): string { root.launch("web"); return "ok" }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰧑"
    active: root.status.live === true
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) root.launch("shell")
      else if (buttonCode === Qt.MiddleButton) root.launch("graph")
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(360))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      onMoveRequested: function(dx, dy) {
        if (dx !== 0) {
          root.cursorActive = true
          root.cursor = ((root.cursor + dx) % root.actions.length + root.actions.length) % root.actions.length
        }
        if (dy !== 0)
          panelFlick.contentY = Math.max(0, Math.min(panelFlick.contentY + dy * Style.space(56),
                                                     Math.max(0, panelFlick.contentHeight - panelFlick.height)))
      }
      onActivateRequested: root.launch(root.actions[root.cursor])
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "r" || t === "R") root.refreshNow()
        else if (t === "s") root.launch("shell")
        else if (t === "g") root.launch("graph")
        else if (t === "w") root.launch("web")
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(12)

          PanelHero {
            width: parent.width
            title: "phren"
            meta: root.summary()
            detail: root.status.version ? "v" + root.status.version : ""
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconComponent: Component {
              Image {
                width: Style.font.display
                height: Style.font.display
                source: Qt.resolvedUrl("assets/phren.png")
                fillMode: Image.PreserveAspectFit
                smooth: true
                mipmap: true
              }
            }
          }

          // ---------- Open: shell · graph · web ----------
          Row {
            width: parent.width
            spacing: Style.space(8)

            Repeater {
              model: [
                { key: "shell", icon: "󰆍", label: "Shell" },
                { key: "graph", icon: "󰙅", label: "Graph" },
                { key: "web", icon: "󰖟", label: "Web viewer" }
              ]
              delegate: Rectangle {
                required property var modelData
                required property int index
                readonly property bool hot: hover.hovered || (root.cursorActive && root.cursor === index)
                width: (column.width - Style.space(16)) / 3
                height: Style.space(56)
                radius: Style.space(8)
                color: hot ? Style.hoverFill : Style.normalFill
                border.width: 1
                border.color: hot ? Style.hoverBorderColor : Style.normalBorderColor

                Column {
                  anchors.centerIn: parent
                  spacing: Style.space(2)
                  Text {
                    anchors.horizontalCenter: parent.horizontalCenter
                    text: modelData.icon
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.icon
                  }
                  Text {
                    anchors.horizontalCenter: parent.horizontalCenter
                    text: modelData.label
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                }

                HoverHandler { id: hover }
                TapHandler { onTapped: root.launch(modelData.key) }
              }
            }
          }

          // ---------- Not installed ----------
          Text {
            visible: !root.status.ok
            width: parent.width
            wrapMode: Text.WordWrap
            text: "No phren store found. Run `npx @phren/cli init` in a terminal, then refresh (r)."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }

          // ---------- Projects ----------
          Text {
            visible: root.status.ok && root.status.projects.length > 0
            text: "PROJECTS"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.letterSpacing: 1
          }

          Column {
            width: parent.width
            spacing: Style.space(4)
            Repeater {
              model: root.status.ok ? root.status.projects.slice(0, 12) : []
              delegate: Item {
                required property var modelData
                width: column.width
                height: nameText.implicitHeight + Style.space(4)
                Text {
                  id: nameText
                  anchors.left: parent.left
                  anchors.right: countText.left
                  anchors.rightMargin: Style.space(8)
                  text: modelData.name
                  elide: Text.ElideRight
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                }
                Text {
                  id: countText
                  anchors.right: parent.right
                  text: modelData.findings + " ✦" + (modelData.tasks > 0 ? "  " + modelData.tasks + " ▤" : "") + "  " + root.ago(modelData.updatedAgoSec)
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }
            }
          }

          // ---------- Recent recalls ----------
          Text {
            visible: root.status.ok
            text: root.status.live ? "RECALLING NOW" : "RECENT RECALLS"
            color: root.status.live ? root.accent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.letterSpacing: 1
          }

          Text {
            visible: root.status.ok && root.status.recalls.length === 0
            width: parent.width
            wrapMode: Text.WordWrap
            text: "Nothing yet. Ask an agent something in a project and its recalls land here."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }

          Column {
            width: parent.width
            spacing: Style.space(6)
            Repeater {
              model: root.status.ok ? root.status.recalls.slice(0, 6) : []
              delegate: Column {
                required property var modelData
                width: column.width
                spacing: Style.space(1)
                Row {
                  spacing: Style.space(6)
                  Text {
                    text: root.agoIso(modelData.at)
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                  Text {
                    text: (modelData.source || "lookup") + " · " + (modelData.project || "")
                    color: root.accent
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                }
                Text {
                  width: parent.width
                  text: modelData.snippet || ""
                  wrapMode: Text.WordWrap
                  maximumLineCount: 2
                  elide: Text.ElideRight
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                }
              }
            }
          }

          Text {
            width: parent.width
            text: "s shell · g graph · w web · r refresh · esc close"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }
    }
  }
}
