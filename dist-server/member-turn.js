export function memberTurnSelection(selection) {
    return {
        model: selection.model,
        ...(selection.effort ? { effort: selection.effort } : {}),
    };
}
