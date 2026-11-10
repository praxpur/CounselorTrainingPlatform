// 报名与最新一条培训经历合并，年度汇总与个人导出使用同一份数据。
function personalRecords(db, userId) {
  return db
    .prepare(
      `
    SELECT a.id,a.title,a.location,a.status,a.starts_at startsAt,a.ends_at endsAt,
      a.credit_minutes creditMinutes,r.registered_at registeredAt,r.confirmed_at confirmedAt,
      r.credited_minutes creditedMinutes,e.id experienceId,e.description experience,
      e.status experienceStatus,e.review_note reviewNote,e.reviewed_at reviewedAt
    FROM registrations r JOIN activities a ON a.id=r.activity_id
    LEFT JOIN experiences e ON e.id=(
      SELECT latest.id FROM experiences latest
      WHERE latest.user_id=r.user_id AND latest.activity_id=r.activity_id
      ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1
    )
    WHERE r.user_id=? ORDER BY a.starts_at DESC,a.id DESC
  `,
    )
    .all(userId)
    .map((record) => {
      const reviewStatus =
        record.status === 'cancelled'
          ? 'cancelled'
          : record.confirmedAt
            ? 'approved'
            : record.experienceStatus === 'rejected'
              ? 'rejected'
              : record.experienceStatus === 'pending'
                ? 'pending'
                : 'unsubmitted'
      return {
        ...record,
        reviewStatus,
        reviewLabel: {
          approved: '已审核通过',
          rejected: '已驳回',
          pending: '待审核',
          unsubmitted: '未提交经历',
          cancelled: '活动已取消',
        }[reviewStatus],
        recognizedMinutes: reviewStatus === 'approved' ? record.creditedMinutes : 0,
        canSubmit: reviewStatus === 'unsubmitted' || reviewStatus === 'rejected',
      }
    })
}

function personalAnnual(db, userId, year) {
  const start = Date.parse(year + '-01-01T00:00:00+08:00')
  const end = Date.parse(year + 1 + '-01-01T00:00:00+08:00')
  const records = personalRecords(db, userId).filter((r) => r.startsAt >= start && r.startsAt < end)
  const months = Array.from({ length: 12 }, (_, index) => ({ month: index + 1, minutes: 0 }))
  for (const record of records) {
    const month = new Date(record.startsAt + 8 * 3600000).getUTCMonth()
    months[month].minutes += record.recognizedMinutes
  }
  return {
    year,
    records,
    months,
    totalMinutes: records.reduce((sum, r) => sum + r.recognizedMinutes, 0),
    activityCount: records.length,
    approvedCount: records.filter((r) => r.reviewStatus === 'approved').length,
    pendingCount: records.filter((r) => ['pending', 'unsubmitted'].includes(r.reviewStatus)).length,
    rejectedCount: records.filter((r) => r.reviewStatus === 'rejected').length,
    cancelledCount: records.filter((r) => r.reviewStatus === 'cancelled').length,
  }
}

module.exports = { personalRecords, personalAnnual }
