// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { EFSFileView, IEFSIndexer, IEdgeResolverForFileView } from "../EFSFileView.sol";

/// @title EFSFileViewTestable
/// @notice Test-only subclass of `EFSFileView` that shrinks the per-call scan budgets so the
///         phase-0 / phase-1 budget guards (ADR-0048's headline safety mechanism) can be tripped
///         with a handful of seeded items instead of thousands. NOT for deployment — exists purely
///         to exercise the budget paths in `EFSFileViewFiltered.test.ts`.
/// @dev    The production `EFSFileView` reads both budgets through `internal view virtual`
///         accessors (`_folderScanBudgetPerCall` / `_fileScanBudgetPerCall`) that return the 2048
///         constants. Overriding them here to a tiny value is the only behavioral difference; all
///         filter logic is inherited unchanged.
contract EFSFileViewTestable is EFSFileView {
    uint256 private immutable _testBudget;

    constructor(
        IEFSIndexer _indexer,
        IEdgeResolverForFileView _edgeResolver,
        uint256 testBudget
    ) EFSFileView(_indexer, _edgeResolver) {
        _testBudget = testBudget;
    }

    function _folderScanBudgetPerCall() internal view override returns (uint256) {
        return _testBudget;
    }

    function _fileScanBudgetPerCall() internal view override returns (uint256) {
        return _testBudget;
    }
}
