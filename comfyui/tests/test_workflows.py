"""Offline consistency checks; deliberately does not claim GPU validation."""
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORE_TYPES = {
    "CheckpointLoaderSimple", "CLIPTextEncode", "EmptyLatentImage",
    "KSampler", "VAEDecode", "SaveImage",
}


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.models = json.loads((ROOT / "models.json").read_text())["models"]

    def test_exact_manifest_coverage(self):
        self.assertEqual(
            {p.stem for p in (ROOT / "workflows").glob("*.json")},
            {model["id"] for model in self.models},
        )

    def test_graphs_and_downloads(self):
        for model in self.models:
            with self.subTest(model=model["id"]):
                workflow = json.loads(
                    (ROOT / "workflows" / (model["id"] + ".json")).read_text()
                )
                self.assertEqual(workflow["version"], 0.4)
                nodes = {n["id"]: n for n in workflow["nodes"]}
                self.assertEqual(len(nodes), len(workflow["nodes"]))
                self.assertEqual({n["type"] for n in nodes.values()}, CORE_TYPES)
                links = {link[0]: link for link in workflow["links"]}
                self.assertEqual(len(links), len(workflow["links"]))
                for link_id, source, out_slot, target, in_slot, kind in links.values():
                    output = nodes[source]["outputs"][out_slot]
                    input_ = nodes[target]["inputs"][in_slot]
                    self.assertEqual(input_["link"], link_id)
                    self.assertIn(link_id, output["links"])
                    self.assertEqual(output["type"], kind)
                    self.assertEqual(input_["type"], kind)
                for node in nodes.values():
                    self.assertEqual(node["properties"]["cnr_id"], "comfy-core")
                    for input_ in node["inputs"]:
                        self.assertIn(input_["link"], links)
                    for output in node["outputs"]:
                        self.assertTrue(set(output["links"]) <= links.keys())
                loader = next(n for n in nodes.values() if n["type"] == "CheckpointLoaderSimple")
                artifact = loader["properties"]["models"][0]
                self.assertEqual(artifact["directory"] + "/" + artifact["name"], model["files"][0]["path"])
                self.assertEqual(artifact["url"], model["files"][0]["url"])
                self.assertNotIn("/resolve/main/", artifact["url"])
                self.assertEqual(loader["widgets_values"], [artifact["name"]])
                settings = model["recommended"]
                latent = next(n for n in nodes.values() if n["type"] == "EmptyLatentImage")
                self.assertEqual(latent["widgets_values"], [settings["width"], settings["height"], 1])
                sampler = next(n for n in nodes.values() if n["type"] == "KSampler")
                self.assertEqual(
                    sampler["widgets_values"][2:],
                    [settings["steps"], settings["cfg"], settings["sampler"], settings["scheduler"], 1],
                )
                sink = next(n["id"] for n in nodes.values() if n["type"] == "SaveImage")
                reached, pending = set(), [sink]
                while pending:
                    node_id = pending.pop()
                    if node_id in reached:
                        continue
                    reached.add(node_id)
                    pending.extend(links[i["link"]][1] for i in nodes[node_id]["inputs"])
                self.assertEqual(reached, nodes.keys())


if __name__ == "__main__":
    unittest.main()
