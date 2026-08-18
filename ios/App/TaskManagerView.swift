import SwiftUI
import CompanionCore

/// A bot's separate contexts. Tasks remain a compact sheet because they are
/// conversation navigation, not host configuration.
struct TaskManagerView: View {
    let bot: Bot
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var showingNewTask = false
    @State private var taskToRename: BotTask?
    @State private var title = ""

    private var current: Bot { session.state.bot(bot.id) ?? bot }
    private var tasks: [BotTask] { current.tasks ?? [] }

    var body: some View {
        NavigationStack {
            List {
                ForEach(tasks, id: \.threadId) { task in
                    Button {
                        Task {
                            await session.switchTask(task, for: current)
                            dismiss()
                        }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(task.title.isEmpty ? "Untitled task" : task.title)
                                    .foregroundStyle(Color.primary)
                                Text(RelativeStamp.list(task.createdAt))
                                    .font(.caption)
                                    .foregroundStyle(Color.secondary)
                            }
                            Spacer()
                            if task.threadId == current.threadId {
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor)
                            }
                        }
                    }
                    .contextMenu {
                        Button("Rename", systemImage: "pencil") {
                            title = task.title
                            taskToRename = task
                        }
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task { await session.deleteTask(task, for: current) }
                        } label: { Label("Delete", systemImage: "trash") }
                        .disabled(tasks.count <= 1 || current.busy == true)
                    }
                }
            }
            .navigationTitle("\(current.name)’s tasks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button("New task", systemImage: "plus") {
                        title = ""
                        showingNewTask = true
                    }
                    .disabled(current.busy == true)
                }
            }
        }
        .alert("New task", isPresented: $showingNewTask) {
            TextField("Title (optional)", text: $title)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                Task {
                    await session.createTask(for: current, title: title.trimmingCharacters(in: .whitespacesAndNewlines))
                    dismiss()
                }
            }
        }
        .alert("Rename task", isPresented: Binding(
            get: { taskToRename != nil },
            set: { if !$0 { taskToRename = nil } }
        )) {
            TextField("Title", text: $title)
            Button("Cancel", role: .cancel) { taskToRename = nil }
            Button("Save") {
                guard let task = taskToRename else { return }
                Task { await session.renameTask(task, for: current, title: title) }
                taskToRename = nil
            }
        }
    }
}
