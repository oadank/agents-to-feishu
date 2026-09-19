process.env.CTI_SKILLS_DIRS = "C:\\Users\\oadan\\.dsh\\skills";
const { skillRoots, listSkills } = await import("../../src/tools/skills.js");
const rs = skillRoots(); console.log("roots=", JSON.stringify(rs.map((r: string) => r.slice(0, 45))));
console.log("count=", listSkills().length);
